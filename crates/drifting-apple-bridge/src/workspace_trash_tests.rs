//! Local recoverable chapter lifecycle through the real C ABI. Optional exports
//! contain actual originals and closed SQLite copies for the production TS oracle.
use super::*;
use std::collections::BTreeMap;

const FILE: &str = "apple-native-workspace.db";
const FAULT: &str = "CREATE TRIGGER fail_chapter_trash_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic chapter lifecycle receipt fault'); END";

fn handle(fixture: &Fixture, index: usize) -> u64 {
    fixture.open(index)["handle"].as_u64().unwrap()
}
fn request(fixture: &Fixture, operation: &str) -> Value {
    json!({"operation":operation,"handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]})
}
fn live(fixture: &Fixture) -> Value {
    success(
        json!({"operation":"workspaceChapters","handle":fixture.workspace,"projectId":fixture.project}),
    )
}
fn trash(fixture: &Fixture) -> Value {
    success(
        json!({"operation":"workspaceTrashedChapters","handle":fixture.workspace,"projectId":fixture.project}),
    )
}
fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn rows(db: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    [
        "project",
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
fn assert_rows_unchanged(db: &DatabaseGateway, before: &BTreeMap<String, Vec<Vec<DatabaseValue>>>) {
    let after = rows(db);
    for (table, expected) in before {
        if table == "yjs_snapshots" {
            // Release preflight may refresh the snapshot timestamp. Its exact
            // document ID and body must survive a failed metadata transaction.
            let without_time = |rows: &Vec<Vec<DatabaseValue>>| {
                rows.iter().map(|row| row[..2].to_vec()).collect::<Vec<_>>()
            };
            assert!(
                without_time(&after[table]) == without_time(expected),
                "snapshot bytes changed on failure"
            );
        } else {
            assert!(
                after.get(table) == Some(expected),
                "table {table} changed on failure"
            );
        }
    }
}
fn lifecycle(db: &DatabaseGateway, chapter: &str) -> Vec<Vec<DatabaseValue>> {
    db.query("SELECT incarnation,state FROM sync_entity_lifecycle WHERE entity_kind='node' AND entity_id=?".into(),
        vec![text(chapter)],None,CLIENT.into()).unwrap().rows
}
fn revision(db: &DatabaseGateway, chapter: &str) -> u64 {
    let rows = db
        .query(
            "SELECT revision FROM yjs_document_revision WHERE document_id=?".into(),
            vec![text(&format!("node-content:{chapter}"))],
            None,
            CLIENT.into(),
        )
        .unwrap()
        .rows;
    let DatabaseValue::Integer(value) = &rows[0][0] else {
        panic!("revision")
    };
    value.parse().unwrap()
}
fn latest(db: &DatabaseGateway) -> Value {
    let rows=query(db,"SELECT encoded_bytes,mutation_count,created_at FROM sync_change_set WHERE origin='local' ORDER BY rowid DESC LIMIT 1");
    let DatabaseValue::Blob(bytes) = &rows[0][0] else {
        panic!("original bytes")
    };
    let DatabaseValue::Integer(count) = &rows[0][1] else {
        panic!("mutation count")
    };
    let DatabaseValue::Text(created) = &rows[0][2] else {
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
        let directory = PathBuf::from(std::env::var("NATIVE_WORKSPACE_TRASH_EXPORT_DIR").ok()?);
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
            fixture: json!({"name":name,"beforeDatabase":file,"projectId":fixture.project,
            "chapterId":fixture.chapters[0],"documentId":format!("node-content:{}",fixture.chapters[0]),
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
    fn step(&mut self, fixture: &Fixture, db: &DatabaseGateway, operation: &str, fault: bool) {
        let index = self.fixture["steps"].as_array().unwrap().len();
        let file = format!("{}-after-{index}.db", self.name);
        Self::copy(fixture, db, &self.directory.join(&file));
        let mut step = latest(db);
        step["afterDatabase"] = json!(file);
        step["operation"] = json!(operation);
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
fn workspace_chapter_trash_preserves_prose_and_placement() {
    let mut fixture = Fixture::new();
    let owner = handle(&fixture, 0);
    let other = handle(&fixture, 1);
    insert(owner, "合成正文 e\u{301}🙂");
    insert(other, "另一章历史");
    let other_state = state(other);
    let db = gateway(other);
    let before = rows(&db);
    let chapters = live(&fixture);
    let before_revision = revision(&db, &fixture.chapters[0]);
    let mut export = Export::start("chapter-trash-preserves-prose-and-placement", &fixture, &db);
    let reply = success(request(&fixture, "workspaceTrashChapter"));
    assert_eq!(reply["projectId"], fixture.project);
    assert_eq!(reply["chapterId"], fixture.chapters[0]);
    assert_eq!(reply["chapters"].as_array().unwrap().len(), 1);
    assert_eq!(reply["trashedChapters"].as_array().unwrap().len(), 1);
    let trashed = trash(&fixture);
    assert_eq!(trashed[0]["id"], fixture.chapters[0]);
    assert_eq!(trashed[0]["title"], chapters[0]["title"]);
    assert_eq!(trashed[0]["bookOrder"], chapters[0]["bookOrder"]);
    assert_eq!(
        lifecycle(&db, &fixture.chapters[0]),
        vec![vec![DatabaseValue::Integer("0".into()), text("trashed")]]
    );
    assert_eq!(revision(&db, &fixture.chapters[0]), before_revision);
    assert_eq!(latest(&db)["mutationCount"], 1);
    assert!(!rejected(json!({"operation":"documentRead","handle":owner})).is_empty());
    assert!(!rejected(request(&fixture, "workspaceOpenChapter")).is_empty());
    for table in [
        "node_content",
        "yjs_updates",
        "yjs_document_revision",
        "yjs_document_revision_provenance",
        "sync_yjs_materialization_receipt",
        "comment",
        "comment_action",
    ] {
        assert!(rows(&db)[table] == before[table], "trash changed {table}");
    }
    assert_eq!(handle(&fixture, 1), other);
    assert_eq!(state(other), other_state);
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trash", false);
    }
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":other}))["projection"]["text"],
        ""
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(trash(&fixture)[0]["id"], fixture.chapters[0]);
    assert_eq!(live(&fixture).as_array().unwrap().len(), 1);
    fixture.close();
}

#[test]
fn workspace_chapter_restore_reincarnates_and_remains_editable() {
    let mut fixture = Fixture::new();
    let owner = handle(&fixture, 0);
    let other = handle(&fixture, 1);
    let content = "恢复正文 e\u{301}🙂";
    insert(owner, content);
    let original = state(owner);
    success(json!({"operation":"documentFormat","handle":owner,"edit":{
        "revision":original["projection"]["revision"],"range":{"location":0,"length":2},"action":"bold"}}));
    let styled = state(owner);
    let db = gateway(other);
    let before_revision = revision(&db, &fixture.chapters[0]);
    let mut export = Export::start(
        "chapter-restore-reincarnates-and-remains-editable",
        &fixture,
        &db,
    );
    success(request(&fixture, "workspaceTrashChapter"));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trash", false);
    }
    let reply = success(request(&fixture, "workspaceRestoreChapter"));
    assert_eq!(reply["chapters"].as_array().unwrap().len(), 2);
    assert_eq!(reply["trashedChapters"], json!([]));
    assert_eq!(
        lifecycle(&db, &fixture.chapters[0]),
        vec![vec![DatabaseValue::Integer("1".into()), text("live")]]
    );
    assert_eq!(revision(&db, &fixture.chapters[0]), before_revision + 1);
    assert_eq!(latest(&db)["mutationCount"], 4);
    assert!(!rejected(json!({"operation":"documentRead","handle":owner})).is_empty());
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restore", false);
    }
    let restored = fixture.open(0);
    let fresh = restored["handle"].as_u64().unwrap();
    assert_ne!(fresh, owner);
    assert_eq!(restored["document"]["projection"]["text"], content);
    assert_eq!(
        restored["document"]["projection"]["blocks"],
        styled["projection"]["blocks"]
    );
    assert_eq!(restored["document"]["projection"]["canUndo"], false);
    insert(fresh, "续写 ");
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":fresh}))["projection"]["text"],
        content
    );
    fixture.close();
    fixture.workspace = success(json!({"operation":"workspaceOpen","directory":fixture.directory}))
        ["handle"]
        .as_u64()
        .unwrap();
    assert_eq!(fixture.open(0)["document"]["projection"]["text"], content);
    fixture.close();
}

#[test]
fn workspace_chapter_trash_restore_rollback_and_owner_retention() {
    let fixture = Fixture::new();
    let owner = handle(&fixture, 0);
    let other = handle(&fixture, 1);
    insert(owner, "失败时保留正文🙂");
    let original = state(owner);
    let other_state = state(other);
    let db = gateway(other);
    let before = rows(&db);
    success(
        json!({"operation":"documentBeginDraft","handle":owner,"start":{
        "key":"trash-composition-branch","revision":original["projection"]["revision"],"range":{"location":0,"length":0}}}),
    );
    assert!(!rejected(request(&fixture, "workspaceTrashChapter")).is_empty());
    assert_rows_unchanged(&db, &before);
    assert_eq!(state(owner), original);
    assert_eq!(
        SESSIONS.get().unwrap().lock().unwrap()[&owner]
            .document
            .active_drafts(),
        1
    );
    success(
        json!({"operation":"documentCancelDraft","handle":owner,"key":"trash-composition-branch"}),
    );
    let mut export = Export::start(
        "chapter-trash-restore-rollback-and-owner-retention",
        &fixture,
        &db,
    );
    execute(&db, FAULT);
    assert!(rejected(request(&fixture, "workspaceTrashChapter"))
        .contains("synthetic chapter lifecycle receipt fault"));
    assert_rows_unchanged(&db, &before);
    assert_eq!(state(owner), original);
    assert_eq!(state(other), other_state);
    execute(&db, "DROP TRIGGER fail_chapter_trash_receipt");
    success(request(&fixture, "workspaceTrashChapter"));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "trash", true);
    }
    let trashed = rows(&db);
    execute(&db, FAULT);
    assert!(rejected(request(&fixture, "workspaceRestoreChapter"))
        .contains("synthetic chapter lifecycle receipt fault"));
    assert_rows_unchanged(&db, &trashed);
    assert_eq!(state(other), other_state);
    execute(&db, "DROP TRIGGER fail_chapter_trash_receipt");
    success(request(&fixture, "workspaceRestoreChapter"));
    if let Some(export) = &mut export {
        export.step(&fixture, &db, "restore", true);
    }
    let restored = fixture.open(0);
    assert_eq!(
        restored["document"]["projection"]["text"],
        original["projection"]["text"]
    );
    assert_eq!(restored["document"]["projection"]["canUndo"], false);
    assert_eq!(handle(&fixture, 1), other);
    assert_eq!(state(other), other_state);
    fixture.close();
}
