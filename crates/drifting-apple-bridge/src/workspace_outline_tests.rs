use super::*;
use drifting_document::{Edit, NativeFormatAction, NativeRange};
use std::collections::BTreeMap;

fn tables(database: &DatabaseGateway) -> BTreeMap<String, Vec<Vec<DatabaseValue>>> {
    let names = database.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name".into(),
        vec![], None, CLIENT.into()).unwrap();
    names
        .rows
        .into_iter()
        .map(|row| {
            let DatabaseValue::Text(name) = &row[0] else {
                panic!("table name")
            };
            let mut rows = database
                .query(
                    format!("SELECT * FROM \"{}\"", name.replace('"', "\"\"")),
                    vec![],
                    None,
                    CLIENT.into(),
                )
                .unwrap()
                .rows;
            rows.sort_by_key(|row| serde_json::to_string(row).unwrap());
            (name.clone(), rows)
        })
        .collect()
}

fn outline(fixture: &Fixture, index: usize) -> Value {
    success(
        json!({"operation":"workspaceChapterOutline","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[index]}),
    )
}

#[test]
fn workspace_outline_reads_live_and_lazy_chapters_without_sql_writes_or_owner_switch() {
    let fixture = Fixture::new();
    let cold = fixture.open(0)["handle"].as_u64().unwrap();
    insert(cold, " 场🙂 \n拍\n注");
    format_document(cold, "heading1", json!({"location":0,"length":0}));
    format_document(cold, "heading2", json!({"location":6,"length":0}));
    format_document(cold, "heading3", json!({"location":8,"length":0}));
    let expected = state(cold)["projection"]["outline"].clone();
    assert_eq!(expected.as_array().unwrap().len(), 3);
    let handle = fixture.open(1)["handle"].as_u64().unwrap();
    insert(handle, "当前");
    format_document(handle, "heading1", json!({"location":0,"length":0}));
    let database = gateway(handle);
    // A deliberately stale derived cache must never become prose authority.
    execute(&database, "UPDATE node_content SET outline_json='[]'");
    {
        let mut sessions = SESSIONS.get().unwrap().lock().unwrap();
        let owner = sessions.get_mut(&handle).unwrap();
        let revision = owner.document.native_projection().unwrap().revision;
        owner
            .document
            .replace_native(NativeReplacement {
                revision,
                range: NativeRange {
                    location: 2,
                    length: 0,
                },
                text: "尚未保存🙂".into(),
            })
            .unwrap();
    }
    let before = tables(&database);
    let live = state(handle);
    let exported = success(json!({"operation":"documentExport","handle":handle}));
    let rows = success(
        json!({"operation":"workspaceOutline","handle":fixture.workspace,"projectId":fixture.project}),
    );
    assert_eq!(
        rows,
        json!([
            {"kind":"chapter","id":fixture.chapters[0],"title":"初航","actId":null},
            {"kind":"chapter","id":fixture.chapters[1],"title":"归航","actId":null}
        ])
    );
    assert_eq!(outline(&fixture, 0), expected);
    let current = outline(&fixture, 1);
    assert_eq!(current, live["projection"]["outline"]);
    assert_eq!(current[0]["text"], "当前尚未保存🙂");
    assert_eq!(state(handle), live);
    assert_eq!(
        success(json!({"operation":"documentExport","handle":handle})),
        exported
    );
    assert_eq!(
        tables(&database),
        before,
        "all user tables, journal, revision and checkpoint unchanged"
    );
    // The same public handle still owns its most recent local history unit.
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        "当前"
    );
    fixture.close();
}

#[test]
fn workspace_outline_rejects_foreign_chapters_and_unsafe_tail_without_touching_database() {
    let fixture = Fixture::new();
    let handle = fixture.open(1)["handle"].as_u64().unwrap();
    insert(handle, "保留当前历史");
    let database = gateway(handle);
    let other = success(
        json!({"operation":"workspaceCreateProject","handle":fixture.workspace,"name":"另一个项目"}),
    );
    let mut old = DocumentSession::new();
    old.edit(Edit::AppendParagraph {
        id: "cold-p".into(),
        text: "冷章节".into(),
    })
    .unwrap();
    let mut checkpoint = DocumentSession::new();
    checkpoint
        .apply_remote(&old.update(None, 1).unwrap(), 1)
        .unwrap();
    checkpoint
        .format_native(NativeFormatting {
            revision: checkpoint.native_projection().unwrap().revision,
            range: NativeRange {
                location: 0,
                length: 0,
            },
            action: NativeFormatAction::Heading1,
        })
        .unwrap();
    let vector = old.state_vector();
    old.edit(Edit::Insert {
        block: "cold-p".into(),
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
        &old.update(Some(&vector), 1).unwrap(),
        &RevisionSource::Remote,
        "2026-09-26T00:00:00Z",
        None,
        None,
    )
    .unwrap();
    let before = tables(&database);
    let live = state(handle);
    assert!(rejected(
        json!({"operation":"workspaceChapterOutline","handle":fixture.workspace,
        "projectId":fixture.project,"chapterId":fixture.chapters[0]})
    )
    .contains("REMOTE_TEXT_RETENTION_REQUIRED"));
    assert!(rejected(
        json!({"operation":"workspaceChapterOutline","handle":fixture.workspace,
        "projectId":other["id"],"chapterId":fixture.chapters[0]})
    )
    .contains("not available"));
    assert!(rejected(
        json!({"operation":"workspaceOutline","handle":fixture.workspace,
        "projectId":"foreign-project"})
    )
    .contains("does not belong"));
    assert_eq!(tables(&database), before);
    assert_eq!(state(handle), live);
    assert_eq!(
        success(json!({"operation":"documentUndo","handle":handle}))["projection"]["text"],
        ""
    );
    fixture.close();
}
