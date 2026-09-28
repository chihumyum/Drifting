//! Storylines, chapter membership and storyline bodies through the C ABI.
//! Optional SQLite exports feed the production TypeScript reducer.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_line_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic storyline receipt fault'); END";

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "storylines",
        "node_storyline_link",
        "book_node",
        "sync_change_set",
        "sync_mutation",
        "sync_apply_receipt",
        "sync_generation_writer_state",
        "sync_entity_lifecycle",
        "sync_field_clock",
        "sync_set_tag",
        "sync_order_register",
        "yjs_updates",
        "yjs_document_revision",
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
fn actions(db: &DatabaseGateway) -> Vec<String> {
    query(db, "SELECT m.action||' '||m.target_kind FROM sync_mutation m JOIN sync_change_set c USING(change_set_id) WHERE c.rowid=(SELECT MAX(rowid) FROM sync_change_set) ORDER BY m.mutation_index")
        .into_iter()
        .map(|row| match &row[0] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("action"),
        })
        .collect()
}
fn latest(db: &DatabaseGateway) -> Value {
    let values = query(db, "SELECT encoded_bytes,mutation_count,created_at FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1");
    let DatabaseValue::Blob(bytes) = &values[0][0] else {
        panic!("original")
    };
    let DatabaseValue::Integer(count) = &values[0][1] else {
        panic!("count")
    };
    let DatabaseValue::Text(created) = &values[0][2] else {
        panic!("created")
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
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_STORYLINE_EXPORT_DIR").ok()?);
        std::fs::create_dir_all(&directory).unwrap();
        let file = format!("{name}-before.db");
        Self::copy(fixture, db, &directory.join(&file));
        let writer = query(
            db,
            "SELECT installation_id,writer_id,writer_epoch FROM sync_generation_writer_state",
        );
        let string = |index| match &writer[0][index] {
            DatabaseValue::Text(value) => value.clone(),
            _ => panic!("writer"),
        };
        Some(Self {
            directory,
            name,
            fixture: json!({"name":name,"beforeDatabase":file,"projectId":fixture.project,
            "chapterIds":fixture.chapters,
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
        reply: &Value,
        fault: bool,
    ) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let mut step = latest(db);
        step["afterDatabase"] = json!(file);
        step["operation"] = json!(operation);
        step["result"] = reply["result"].clone();
        step["library"] = reply["library"].clone();
        step["faultBeforeApply"] = json!(fault);
        self.fixture["steps"].as_array_mut().unwrap().push(step);
        std::fs::write(
            self.directory.join(format!("{}.json", self.name)),
            serde_json::to_vec_pretty(&self.fixture).unwrap(),
        )
        .unwrap();
    }
}
fn command(fixture: &Fixture, command: Value) -> Value {
    success(
        json!({"operation":"workspaceStorylines","handle":fixture.workspace,"projectId":fixture.project,"command":command}),
    )
}
fn refused(fixture: &Fixture, command: Value) -> String {
    rejected(
        json!({"operation":"workspaceStorylines","handle":fixture.workspace,"projectId":fixture.project,"command":command}),
    )
}
fn memberships(reply: &Value) -> Vec<(String, Vec<String>, Option<String>)> {
    reply["library"]["memberships"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["chapterId"].as_str().unwrap().into(),
                m["storylineIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().into())
                    .collect(),
                m["primary"].as_str().map(Into::into),
            )
        })
        .collect()
}

#[test]
fn workspace_storylines_create_assign_order_and_cold_reopen() {
    let mut fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let mut export = Export::start(
        "storyline-create-assign-order-and-cold-reopen",
        &fixture,
        &db,
    );
    let created = command(&fixture, json!({"action":"createStoryline","name":"主线"}));
    let main = created["result"].clone();
    assert_eq!(main["orderKey"], 0);
    assert_eq!(
        actions(&db),
        [
            "entity.create storyline",
            "yjs.update prose-document",
            "order.move storyline",
            "set.add membership",
            "field.set node-storyline-primary",
            "set.add membership",
            "field.set node-storyline-primary"
        ]
    );
    // Both chapters now have the first storyline as primary.
    assert!(memberships(&created).iter().all(|(_, ids, primary)| ids
        == &vec![main["id"].as_str().unwrap().to_string()]
        && primary.as_deref() == main["id"].as_str()));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createStoryline", &created, false);
    }
    let side_reply = command(&fixture, json!({"action":"createStoryline","name":"主线"}));
    let side = side_reply["result"].clone();
    assert_eq!(side["name"], "主线 2");
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "createStoryline", &side_reply, false);
    }
    let updated = command(
        &fixture,
        json!({"action":"updateStoryline","storylineId":side["id"],"name":"支线🙂","summary":"雨夜"}),
    );
    assert_eq!(actions(&db), ["field.set storyline", "field.set storyline"]);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "updateStoryline", &updated, false);
    }
    let assigned = command(
        &fixture,
        json!({"action":"setChapterStorylines","chapterId":fixture.chapters[1],
        "storylineIds":[side["id"], main["id"]],"primary":side["id"]}),
    );
    assert_eq!(
        actions(&db),
        ["set.add membership", "field.set node-storyline-primary"]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setChapterStorylines", &assigned, false);
    }
    let moved = command(
        &fixture,
        json!({"action":"moveStoryline","storylineId":side["id"],"beforeStorylineId":main["id"]}),
    );
    assert_eq!(
        actions(&db),
        ["order.rebalance storyline", "order.rebalance storyline"]
    );
    assert_eq!(moved["library"]["storylines"][0]["id"], side["id"]);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "moveStoryline", &moved, false);
    }
    let removed = command(
        &fixture,
        json!({"action":"setChapterStorylines","chapterId":fixture.chapters[1],"storylineIds":[main["id"]],"primary":main["id"]}),
    );
    assert_eq!(
        actions(&db),
        ["set.remove membership", "field.set node-storyline-primary"]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setChapterStorylines", &removed, false);
    }
    let faceted = command(
        &fixture,
        json!({"action":"setStorylineFacts","storylineId":main["id"],"facts":[{"key":"主题","value":"归乡"}]}),
    );
    assert_eq!(
        faceted["result"]["facts"],
        json!([{"key":"主题","value":"归乡"}])
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "setStorylineFacts", &faceted, false);
    }
    // The storyline body is a durable owner of its own.
    let body = command(
        &fixture,
        json!({"action":"openStoryline","storylineId":main["id"]}),
    )["handle"]
        .as_u64()
        .unwrap();
    let current = state(body);
    success(
        json!({"operation":"documentReplace","handle":body,"edit":{"revision":current["projection"]["revision"],
        "range":{"location":0,"length":0},"text":"主线梗概"}}),
    );
    let expected = memberships(&removed);
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    let library = command(&fixture, json!({"action":"library"}));
    assert_eq!(memberships(&library), expected);
    assert_eq!(library["library"]["storylines"][0]["name"], "支线🙂");
    let body = command(
        &fixture,
        json!({"action":"openStoryline","storylineId":main["id"]}),
    );
    assert_eq!(body["document"]["projection"]["text"], "主线梗概");
    fixture.close();
}

#[test]
fn workspace_storylines_trash_restore_and_chapter_membership_restore() {
    let fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let main =
        command(&fixture, json!({"action":"createStoryline","name":"主线"}))["result"].clone();
    let side =
        command(&fixture, json!({"action":"createStoryline","name":"支线"}))["result"].clone();
    command(
        &fixture,
        json!({"action":"setChapterStorylines","chapterId":fixture.chapters[1],"storylineIds":[main["id"], side["id"]],"primary":side["id"]}),
    );
    let mut export = Export::start(
        "storyline-trash-restore-and-chapter-membership-restore",
        &fixture,
        &db,
    );
    let trashed = command(
        &fixture,
        json!({"action":"trashStoryline","storylineId":main["id"]}),
    );
    assert_eq!(
        actions(&db),
        [
            "set.remove membership",
            "field.set node-storyline-primary",
            "set.remove membership",
            "field.set node-storyline-primary",
            "entity.trash storyline"
        ]
    );
    assert_eq!(memberships(&trashed)[0].1, Vec::<String>::new());
    assert_eq!(
        memberships(&trashed)[1].1,
        vec![side["id"].as_str().unwrap().to_string()]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trashStoryline", &trashed, false);
    }
    let restored = command(
        &fixture,
        json!({"action":"restoreStoryline","storylineId":main["id"]}),
    );
    assert_eq!(
        actions(&db),
        [
            "entity.restore storyline",
            "order.move storyline",
            "yjs.update prose-document"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restoreStoryline", &restored, false);
    }
    // Chapter trash keeps its links; restore re-authors them in the new incarnation.
    success(
        json!({"operation":"workspaceTrashChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trashChapter", &json!({}), false);
    }
    success(
        json!({"operation":"workspaceRestoreChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":fixture.chapters[1]}),
    );
    assert_eq!(
        actions(&db),
        [
            "entity.restore node",
            "tuple.set node",
            "set.remove membership",
            "set.add membership",
            "field.set node-storyline-primary",
            "yjs.update prose-document"
        ]
    );
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restoreChapter", &json!({}), false);
    }
    let library = command(&fixture, json!({"action":"library"}));
    assert_eq!(
        memberships(&library)[1],
        (
            fixture.chapters[1].clone(),
            vec![side["id"].as_str().unwrap().into()],
            side["id"].as_str().map(Into::into)
        )
    );
    fixture.close();
}

#[test]
fn workspace_storylines_failures_roll_back_and_retry() {
    let fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let mut export = Export::start("storyline-failures-roll-back-and-retry", &fixture, &db);
    let mut storyline = Value::Null;
    for step in [
        "createStoryline",
        "setChapterStorylines",
        "updateStoryline",
        "trashStoryline",
    ] {
        let request = match step {
            "createStoryline" => json!({"action":step,"name":"暗线"}),
            "setChapterStorylines" => {
                json!({"action":step,"chapterId":fixture.chapters[0],"storylineIds":[],"primary":null})
            }
            "updateStoryline" => {
                json!({"action":step,"storylineId":storyline["id"],"color":"#102030"})
            }
            _ => json!({"action":step,"storylineId":storyline["id"]}),
        };
        let before = rows(&db);
        execute(&db, FAULT);
        assert!(refused(&fixture, request.clone()).contains("synthetic storyline receipt fault"));
        unchanged(&db, &before);
        execute(&db, "DROP TRIGGER fail_line_receipt");
        let reply = command(&fixture, request);
        if step == "createStoryline" {
            storyline = reply["result"].clone();
        }
        if let Some(export) = &mut export {
            export.step(&fixture, &db, step, &reply, true);
        }
    }
    let before = rows(&db);
    for request in [
        json!({"action":"setChapterStorylines","chapterId":fixture.chapters[0],"storylineIds":[storyline["id"]]}),
        json!({"action":"updateStoryline","storylineId":storyline["id"],"color":"red"}),
        json!({"action":"moveStoryline","storylineId":"missing"}),
        json!({"action":"setChapterStorylines","chapterId":"missing-chapter","storylineIds":[]}),
        json!({"action":"createStoryline","name":"x","unknown":1}),
    ] {
        assert!(!refused(&fixture, request).is_empty());
    }
    unchanged(&db, &before);
    fixture.close();
}

#[test]
fn storyline_chapter_template_seeds_new_chapters_of_that_storyline() {
    let mut fixture = Fixture::new();
    let db = gateway(fixture.open(0)["handle"].as_u64().unwrap());
    let lines = |command: Value| {
        success(
            json!({"operation":"workspaceStorylines","handle":fixture.workspace,
            "projectId":fixture.project,"command":command}),
        )
    };
    let storyline = lines(json!({"action":"createStoryline","name":"主线"}))["result"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let blocks = json!([
        {"kind":"heading","level":2,"text":"开场","marks":[]},
        {"kind":"paragraph","level":null,"text":"要点：","marks":[{"mark":"bold","location":0,"length":2}]}
    ]);
    let changes = || query(&db, "SELECT COUNT(*) FROM sync_change_set");
    let before = changes();
    lines(json!({"action":"setChapterTemplate","storylineId":storyline,"blocks":blocks}));
    assert_ne!(changes(), before);
    assert_eq!(
        lines(json!({"action":"chapterTemplate","storylineId":storyline}))["result"],
        blocks
    );
    // The same template again writes nothing.
    let before = changes();
    lines(json!({"action":"setChapterTemplate","storylineId":storyline,"blocks":blocks}));
    assert_eq!(changes(), before);
    // A chapter created in the storyline starts from it and joins it as primary.
    let chapter = success(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":fixture.project,"title":"第三章","storylineId":storyline}),
    );
    let id = chapter["id"].as_str().unwrap().to_string();
    let read = success(
        json!({"operation":"workspaceAgent","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"readProse","target":{"kind":"chapter","id":id}}}),
    );
    assert_eq!(read["text"], "开场\n要点：");
    let memberships = lines(json!({"action":"library"}))["library"]["memberships"].clone();
    let membership = memberships
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["chapterId"] == json!(id))
        .unwrap()
        .clone();
    assert_eq!(membership["primary"], json!(storyline));
    // Without a storyline the chapter starts empty; a missing one refuses first.
    let plain = success(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":fixture.project,"title":"第四章"}),
    );
    let read = success(
        json!({"operation":"workspaceAgent","handle":fixture.workspace,
        "projectId":fixture.project,"command":{"action":"readProse","target":{"kind":"chapter","id":plain["id"]}}}),
    );
    assert_eq!(read["text"], "");
    let before = rows(&db);
    rejected(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":fixture.project,"title":"第五章","storylineId":"missing"}),
    );
    unchanged(&db, &before);
    // An empty template clears it.
    lines(json!({"action":"setChapterTemplate","storylineId":storyline,"blocks":[]}));
    assert_eq!(
        lines(json!({"action":"chapterTemplate","storylineId":storyline}))["result"],
        json!([])
    );
    fixture.close();
}
