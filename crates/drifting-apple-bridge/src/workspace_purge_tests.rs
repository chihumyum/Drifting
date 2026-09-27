//! 彻底删除 through the C ABI: only trashed content, with everything only it
//! owns, one entity or the whole trash.
use super::*;

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn count(db: &DatabaseGateway, sql: &str) -> String {
    match &query(db, sql)[0][0] {
        DatabaseValue::Integer(value) => value.clone(),
        other => panic!("{other:?}"),
    }
}
fn op(fixture: &Fixture, operation: &str, command: Value) -> Value {
    success(json!({"operation":operation,"handle":fixture.workspace,
        "projectId":fixture.project,"command":command}))
}

#[test]
fn workspace_purge_removes_trashed_content_and_what_it_owns() {
    let mut fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let category = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createCategory","name":"地点"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let element = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createElement","categoryId":category,"name":"北塔"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"setElementFacts","elementId":element,"facts":[{"key":"高度","value":"九层"}]}),
    );
    let body = op(
        &fixture,
        "workspaceElements",
        json!({"action":"openElement","elementId":element}),
    )["handle"]
        .as_u64()
        .unwrap();
    let current = state(body);
    success(json!({"operation":"documentReplace","handle":body,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":"塔顶有钟。"}}));
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"closeElement","elementId":element}),
    );
    let sources = tempfile::tempdir().unwrap();
    let png = sources.path().join("portrait.png");
    std::fs::write(&png, b"synthetic portrait bytes").unwrap();
    let portrait = op(
        &fixture,
        "workspaceLibrary",
        json!({"action":"setPortrait","elementId":element,
            "file":{"path":png,"mime":"image/png","extension":"png","width":8,"height":8}}),
    );
    let portrait_path = std::path::PathBuf::from(
        portrait["library"]["portraits"][0]["assetPath"]
            .as_str()
            .unwrap(),
    );
    assert!(portrait_path.exists());
    op(
        &fixture,
        "workspacePatches",
        json!({"action":"createPatch","elementId":element,"title":"倒塌","body":"第二章后只剩地基"}),
    );
    // A live element's patch made from the chapter that will be purged.
    let bell = op(
        &fixture,
        "workspaceElements",
        json!({"action":"createElement","categoryId":category,"name":"钟"}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let chapter_patch = op(
        &fixture,
        "workspacePatches",
        json!({"action":"createPatch","elementId":bell,"title":"来自第二章",
            "source":{"nodeId":fixture.chapters[1]}}),
    )["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    op(
        &fixture,
        "workspaceComments",
        json!({"action":"create","kind":"todo","targetKind":"element","targetId":element,"body":"核对层数"}),
    );
    let storyline = op(
        &fixture,
        "workspaceStorylines",
        json!({"action":"createStoryline","name":"支线"}),
    )["result"]["id"]
        .clone();
    let drift = op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"createDrift","title":"梦"}),
    )["result"]["id"]
        .clone();
    let purge = |fixture: &Fixture, kind: &str, id: &str| {
        json!({"operation":"workspacePurgeTrashed","handle":fixture.workspace,
            "projectId":fixture.project,"kind":kind,"id":id})
    };
    // Live content is refused and nothing is written.
    let before = count(&db, "SELECT COUNT(*) FROM sync_change_set");
    for (kind, id) in [
        ("element", element.as_str()),
        ("chapter", fixture.chapters[1].as_str()),
        ("comment", "x"),
    ] {
        rejected(purge(&fixture, kind, id));
    }
    assert_eq!(count(&db, "SELECT COUNT(*) FROM sync_change_set"), before);
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"trashElement","elementId":element}),
    );
    op(
        &fixture,
        "workspaceElements",
        json!({"action":"trashCategory","categoryId":category}),
    );
    op(
        &fixture,
        "workspaceStorylines",
        json!({"action":"trashStoryline","storylineId":storyline}),
    );
    op(
        &fixture,
        "workspaceDrifts",
        json!({"action":"trashDrift","driftId":drift}),
    );
    success(
        json!({"operation":"workspaceTrashChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    // The trash lists every kind with its title, newest trash first.
    let listed = success(
        json!({"operation":"workspaceTrash","handle":fixture.workspace,
        "projectId":fixture.project}),
    )["trashed"]
        .clone();
    let entries = listed.as_array().unwrap();
    let mut kinds: Vec<&str> = entries
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    kinds.sort_unstable();
    assert_eq!(
        kinds,
        ["category", "chapter", "drift", "element", "storyline"]
    );
    assert!(entries
        .windows(2)
        .all(|pair| pair[0]["trashedAt"].as_str() >= pair[1]["trashedAt"].as_str()));
    assert!(entries
        .iter()
        .any(|e| e["kind"] == "element" && e["title"] == "北塔"));
    // One element goes with its facts, patch, TODO, body and history.
    let purged = success(purge(&fixture, "element", &element));
    assert_eq!(
        purged["purged"][0]["documentId"],
        format!("element:{element}")
    );
    assert_eq!(purged["purged"][0]["assetIds"].as_array().unwrap().len(), 1);
    assert!(
        !portrait_path.exists(),
        "the portrait's bytes go with the element"
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM project_asset"), "0");
    assert_eq!(purged["trashed"].as_array().unwrap().len(), 4);
    for sql in [
        format!("SELECT COUNT(*) FROM element WHERE id='{element}'"),
        format!("SELECT COUNT(*) FROM entity_kv_entry WHERE owner_id='{element}'"),
        format!("SELECT COUNT(*) FROM element_patch WHERE element_id='{element}'"),
        format!("SELECT COUNT(*) FROM comment WHERE target_id='{element}'"),
        format!("SELECT COUNT(*) FROM yjs_updates WHERE document_id='element:{element}'"),
        format!("SELECT COUNT(*) FROM entity_snapshot_history WHERE entity_id='{element}'"),
    ] {
        assert_eq!(count(&db, &sql), "0", "{sql}");
    }
    assert_eq!(
        query(&db, &format!("SELECT state FROM sync_entity_lifecycle WHERE entity_kind='element' AND entity_id='{element}'")),
        vec![vec![DatabaseValue::Text("purged".into())]]
    );
    rejected(
        json!({"operation":"workspaceElements","handle":fixture.workspace,"projectId":fixture.project,
        "command":{"action":"restoreElement","elementId":element}}),
    );
    rejected(purge(&fixture, "element", &element));
    // Emptying needs exactly the confirmed set; anything else writes nothing.
    let confirmed: Vec<Value> = purged["trashed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| json!({"kind": entry["kind"], "id": entry["id"]}))
        .collect();
    let empty = |fixture: &Fixture, confirmed: &[Value]| {
        json!({"operation":"workspaceEmptyTrash","handle":fixture.workspace,
            "projectId":fixture.project,"confirmed":confirmed})
    };
    let before = count(&db, "SELECT COUNT(*) FROM sync_change_set");
    let mut extra = confirmed.clone();
    extra.push(json!({"kind":"element","id":"never-trashed"}));
    for attempt in [&confirmed[1..], &extra[..]] {
        assert!(rejected(empty(&fixture, attempt)).contains("有变化"));
    }
    assert_eq!(count(&db, "SELECT COUNT(*) FROM sync_change_set"), before);
    // Emptying the trash purges the rest in one original.
    let emptied = success(empty(&fixture, &confirmed));
    assert_eq!(emptied["purged"].as_array().unwrap().len(), 4);
    assert_eq!(emptied["trashed"], json!([]));
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM sync_change_set")
            .parse::<u64>()
            .unwrap(),
        before.parse::<u64>().unwrap() + 1
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT COUNT(*) FROM yjs_updates WHERE document_id='node-content:{}'",
                fixture.chapters[1]
            )
        ),
        "0"
    );
    // The live element's patch stays, its purged source cleared in the journal.
    assert_eq!(
        query(
            &db,
            &format!("SELECT source_node_id FROM element_patch WHERE id='{chapter_patch}'")
        ),
        vec![vec![DatabaseValue::Null]]
    );
    assert_eq!(
        count(&db, &format!("SELECT COUNT(*) FROM sync_mutation WHERE target_kind='element-patch' AND target_id='{chapter_patch}' AND action='field.set'")),
        "1"
    );
    // The live chapter is untouched and the trash stays empty after reopening.
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]}),
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(success(empty(&fixture, &[]))["purged"], json!([]));
    fixture.open(0);
    fixture.close();
}
