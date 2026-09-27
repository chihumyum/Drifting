//! Actual local act commands and their canonical originals. Optional SQLite
//! exports feed the production TypeScript reducer; tests always run without it.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_act_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic act receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "project",
        "book_act",
        "book_node",
        "node_content",
        "node_storyline_link",
        "entity_relation",
        "comment",
        "comment_action",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_yjs_materialization_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_conflict",
        "yjs_updates",
        "yjs_snapshots",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ]
    .into_iter()
    .map(|table| {
        (
            table.into(),
            query(db, &format!("SELECT * FROM {table} ORDER BY rowid")),
        )
    })
    .collect()
}
fn unchanged(db: &DatabaseGateway, before: &BTreeMap<String, Vec<Vec<DatabaseValue>>>) {
    let after = rows(db);
    for (table, expected) in before {
        assert!(
            after.get(table) == Some(expected),
            "table {table} changed on failure"
        );
    }
}
fn outline(fixture: &Fixture) -> Value {
    success(
        json!({"operation":"workspaceOutline","handle":fixture.workspace,"projectId":fixture.project}),
    )
}
fn create_request(fixture: &Fixture, chapter: usize) -> Value {
    json!({"operation":"workspaceCreateAct","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[chapter]})
}
fn act_request(fixture: &Fixture, operation: &str, act: &Value) -> Value {
    json!({"operation":operation,"handle":fixture.workspace,"projectId":fixture.project,"actId":act["id"]})
}
fn rename_request(fixture: &Fixture, act: &Value, name: &str) -> Value {
    let mut request = act_request(fixture, "workspaceRenameAct", act);
    request["name"] = json!(name);
    request
}
fn latest(db: &DatabaseGateway) -> Value {
    let values = query(db, "SELECT encoded_bytes,mutation_count,created_at FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1");
    let DatabaseValue::Blob(bytes) = &values[0][0] else {
        panic!("original bytes")
    };
    let DatabaseValue::Integer(count) = &values[0][1] else {
        panic!("mutation count")
    };
    let DatabaseValue::Text(created) = &values[0][2] else {
        panic!("created at")
    };
    json!({"encodedBase64":STANDARD.encode(bytes),"mutationCount":count.parse::<u64>().unwrap(),"createdAt":created})
}
struct Export {
    directory: PathBuf,
    name: &'static str,
    fixture: Value,
}
impl Export {
    fn start(name: &'static str, fixture: &Fixture, db: &DatabaseGateway) -> Option<Self> {
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_ACT_EXPORT_DIR").ok()?);
        std::fs::create_dir_all(&directory).unwrap();
        let file = format!("{name}-before.db");
        Self::copy(fixture, db, &directory.join(&file));
        let writer = query(
            db,
            "SELECT installation_id,writer_id,writer_epoch FROM sync_generation_writer_state",
        );
        assert_eq!(writer.len(), 1);
        let string = |index| match &writer[0][index] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("writer"),
        };
        Some(Self {
            directory,
            name,
            fixture: json!({"name":name,"beforeDatabase":file,
            "projectId":fixture.project,"chapterIds":fixture.chapters,
            "identity":{"installationId":string(0),"writerId":string(1),"writerEpoch":string(2)},"steps":[]}),
        })
    }
    fn copy(fixture: &Fixture, db: &DatabaseGateway, path: &PathBuf) {
        assert_eq!(
            serde_json::to_value(db.checkpoint(CLIENT.into()).unwrap()).unwrap()["busy"],
            0
        );
        std::fs::copy(fixture.directory.join(FILE), path).unwrap();
    }
    fn step(
        &mut self,
        fixture: &Fixture,
        db: &DatabaseGateway,
        operation: &str,
        act: &Value,
        fault: bool,
    ) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let mut step = latest(db);
        step["afterDatabase"] = json!(file);
        step["operation"] = json!(operation);
        step["act"] = act.clone();
        step["outline"] = outline(fixture);
        step["faultBeforeApply"] = json!(fault);
        self.fixture["steps"].as_array_mut().unwrap().push(step);
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn workspace_act_create_rename_and_cold_outline() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let second = fixture.open(1)["handle"].as_u64().unwrap();
    insert(first, "正文🙂 保留章节");
    let before = state(first);
    let db = gateway(first);
    let mut export = Export::start("act-create-rename-and-cold-outline", &fixture, &db);
    let act = success(create_request(&fixture, 1));
    assert_eq!(act["name"], "第一幕");
    assert!(act["startOrder"].as_f64().unwrap().is_finite());
    assert_eq!(
        query(
            &db,
            "SELECT COUNT(*) FROM book_act WHERE start_order IS NULL"
        ),
        vec![vec![DatabaseValue::Integer("0".into())]]
    );
    let actual = outline(&fixture);
    assert_eq!(actual[0]["id"], fixture.chapters[0]);
    assert_eq!(actual[0]["actId"], Value::Null);
    assert_eq!(actual[1]["id"], act["id"]);
    assert_eq!(actual[2]["actId"], act["id"]);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "create", &act, false);
    }
    let renamed = success(rename_request(&fixture, &act, "合成第二航程🙂"));
    assert_eq!(renamed["id"], act["id"]);
    assert_eq!(renamed["startOrder"], act["startOrder"]);
    assert_eq!(renamed["name"], "合成第二航程🙂");
    assert_eq!(state(first), before);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "rename", &renamed, false);
    }
    assert_eq!(fixture.open(0)["handle"], first);
    assert_eq!(fixture.open(1)["handle"], second);
    let expected = outline(&fixture);
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(outline(&fixture), expected);
    assert_eq!(
        fixture.open(0)["document"]["projection"]["text"],
        before["projection"]["text"]
    );
    fixture.close();
}

#[test]
fn workspace_act_remove_retains_empty_boundary_chapter_state() {
    let fixture = Fixture::new();
    let opened = fixture.open(0);
    let owner = opened["handle"].as_u64().unwrap();
    let block = opened["document"]["projection"]["blocks"][0]["id"]
        .as_str()
        .unwrap();
    insert(owner, "正文🙂 保留评论");
    let db = gateway(owner);
    // Only synthetic comment setup uses direct SQL. Every act mutation below
    // goes through the actual workspace command and authored transaction.
    seed_comment(
        &db,
        &fixture.project,
        &fixture.chapters[0],
        block,
        "synthetic-act-comment",
    );
    let owner = fixture.reopen(0)["handle"].as_u64().unwrap();
    insert(owner, "新增 ");
    let second = fixture.open(1)["handle"].as_u64().unwrap();
    insert(second, "另一章 e\u{301}🙂");
    let act = success(create_request(&fixture, 1));
    success(
        json!({"operation":"workspaceMoveChapter","handle":fixture.workspace,"projectId":fixture.project,
        "chapterId":fixture.chapters[1],"beforeChapterId":fixture.chapters[0]}),
    );
    let before_outline = outline(&fixture);
    assert_eq!(
        before_outline.as_array().unwrap().last().unwrap()["id"],
        act["id"]
    );
    assert!(before_outline
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "chapter")
        .all(|row| row["actId"].is_null()));
    let before = rows(&db);
    let owner_state = state(owner);
    let other_state = state(second);
    let mut export = Export::start(
        "act-remove-retains-empty-boundary-chapter-state",
        &fixture,
        &db,
    );
    assert_eq!(
        success(act_request(&fixture, "workspaceRemoveAct", &act)),
        act
    );
    let after = rows(&db);
    for table in [
        "book_node",
        "node_content",
        "node_storyline_link",
        "entity_relation",
        "comment",
        "comment_action",
        "sync_yjs_materialization_receipt",
        "yjs_updates",
        "yjs_snapshots",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
    ] {
        assert!(
            after[table] == before[table],
            "removing a boundary changed {table}"
        );
    }
    assert_eq!(state(owner), owner_state);
    assert_eq!(state(second), other_state);
    assert_eq!(outline(&fixture).as_array().unwrap().len(), 2);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "remove", &act, false);
    }
    assert_eq!(fixture.open(0)["handle"], owner);
    assert_eq!(fixture.open(1)["handle"], second);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":owner}))["projection"]["text"],
        "正文🙂 保留评论"
    );
    assert_eq!(
        success(json!({"operation":"documentRedo","handle":owner}))["projection"]["text"],
        owner_state["projection"]["text"]
    );
    fixture.close();
}

#[test]
fn workspace_act_failure_preserves_owner_and_retries() {
    let fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    insert(owner, "正文 保留失败重试🙂");
    let db = gateway(owner);
    let owner_state = state(owner);
    let mut export = Export::start("act-failure-preserves-owner-and-retries", &fixture, &db);
    let before = rows(&db);
    let mut wrong = create_request(&fixture, 1);
    wrong["projectId"] = json!("synthetic-wrong-project");
    assert!(!rejected(wrong).is_empty());
    unchanged(&db, &before);
    execute(&db, FAULT);
    assert!(rejected(create_request(&fixture, 1)).contains("synthetic act receipt fault"));
    unchanged(&db, &before);
    execute(&db, "DROP TRIGGER fail_act_receipt");
    let act = success(create_request(&fixture, 1));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "create", &act, true);
    }
    let created = rows(&db);
    assert!(!rejected(create_request(&fixture, 1)).is_empty());
    unchanged(&db, &created);
    let mut wrong = rename_request(&fixture, &act, "不应生效");
    wrong["projectId"] = json!("synthetic-wrong-project");
    assert!(!rejected(wrong).is_empty());
    unchanged(&db, &created);
    execute(&db, FAULT);
    assert!(rejected(rename_request(&fixture, &act, "成功后才改名"))
        .contains("synthetic act receipt fault"));
    unchanged(&db, &created);
    execute(&db, "DROP TRIGGER fail_act_receipt");
    let renamed = success(rename_request(&fixture, &act, "成功后才改名"));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "rename", &renamed, true);
    }
    let renamed_rows = rows(&db);
    execute(&db, FAULT);
    assert!(
        rejected(act_request(&fixture, "workspaceRemoveAct", &renamed))
            .contains("synthetic act receipt fault")
    );
    unchanged(&db, &renamed_rows);
    execute(&db, "DROP TRIGGER fail_act_receipt");
    success(act_request(&fixture, "workspaceRemoveAct", &renamed));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "remove", &renamed, true);
    }
    assert_eq!(state(owner), owner_state);
    assert_eq!(fixture.open(0)["handle"], owner);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":owner}))["projection"]["text"],
        ""
    );
    fixture.close();
}

#[test]
fn workspace_act_color_set_clear_and_cold_outline() {
    let mut fixture = Fixture::new();
    let owner = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(owner);
    let act = success(create_request(&fixture, 1));
    let color = |fixture: &Fixture, value: Value| {
        let mut request = act_request(fixture, "workspaceSetActColor", &act);
        request["color"] = value;
        request
    };
    let act_row = |fixture: &Fixture| {
        outline(fixture)
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == act["id"])
            .unwrap()
            .clone()
    };
    assert!(act_row(&fixture).get("color").is_none());
    let changes = |db: &DatabaseGateway| query(db, "SELECT COUNT(*) FROM sync_change_set");
    let before = changes(&db);
    let colored = success(color(&fixture, json!("#3a7bd5")));
    assert_eq!(
        (&colored["color"], &colored["name"]),
        (&json!("#3a7bd5"), &act["name"])
    );
    assert_eq!(act_row(&fixture)["color"], "#3a7bd5");
    let after = changes(&db);
    assert_ne!(after, before);
    // An unchanged colour writes nothing; malformed colours are refused.
    success(color(&fixture, json!("#3a7bd5")));
    for value in ["red", "#12345g", "#fff", ""] {
        rejected(color(&fixture, json!(value)));
    }
    assert_eq!(changes(&db), after);
    // Chapters never carry a colour.
    assert!(outline(&fixture)
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "chapter")
        .all(|row| row.get("color").is_none()));
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(act_row(&fixture)["color"], "#3a7bd5");
    let cleared = success(color(&fixture, Value::Null));
    assert_eq!(cleared["color"], Value::Null);
    assert!(act_row(&fixture).get("color").is_none());
    fixture.close();
}

#[test]
fn workspace_act_move_boundary_between_neighbours() {
    let fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let chapters = success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,
        "projectId":fixture.project}),
    );
    let order = |index: usize| -> f64 {
        let list = chapters["chapters"]
            .as_array()
            .or(chapters.as_array())
            .unwrap();
        list.iter()
            .find(|c| c["id"] == json!(fixture.chapters[index]))
            .unwrap()["bookOrder"]
            .as_f64()
            .unwrap()
    };
    let chapter_act = |chapter: usize| {
        outline(&fixture)
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == json!(fixture.chapters[chapter]))
            .unwrap()["actId"]
            .clone()
    };
    let move_to = |act: &Value, start: f64| {
        let mut request = act_request(&fixture, "workspaceMoveAct", act);
        request["startOrder"] = json!(start);
        request
    };
    let first = success(create_request(&fixture, 1));
    assert_eq!(chapter_act(0), Value::Null);
    // Outline act rows carry their boundary; chapter rows do not.
    let rows = outline(&fixture);
    let act_row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == first["id"])
        .unwrap();
    assert_eq!(act_row["startOrder"], first["startOrder"]);
    assert!(rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "chapter")
        .all(|row| row.get("startOrder").is_none()));
    // Moving the boundary before the first chapter brings it into the act.
    let early = order(0) - 1.0;
    assert_eq!(
        success(move_to(&first, early))["startOrder"].as_f64(),
        Some(early)
    );
    assert_eq!(chapter_act(0), first["id"]);
    let changes = || query(&db, "SELECT COUNT(*) FROM sync_change_set");
    let before = changes();
    success(move_to(&first, early));
    assert_eq!(changes(), before, "an unchanged boundary writes nothing");
    // A boundary never crosses its neighbours.
    let second = success(create_request(&fixture, 1));
    let late = second["startOrder"].as_f64().unwrap();
    let before = changes();
    for (act, start) in [
        (&first, late),
        (&first, late + 1.0),
        (&second, early),
        (&second, early - 1.0),
    ] {
        assert!(rejected(move_to(act, start)).contains("相邻"));
    }
    assert_eq!(changes(), before);
    let between = (early + late) / 2.0;
    success(move_to(&second, between));
    assert_eq!(
        (chapter_act(0), chapter_act(1)),
        (
            if order(0) < between {
                first["id"].clone()
            } else {
                second["id"].clone()
            },
            second["id"].clone()
        )
    );
    fixture.close();
}
