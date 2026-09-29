//! The native Agent's prose tools through the C ABI: reading live or stored
//! bodies and applying accepted revisions through their document owners.
use super::*;

fn query(db: &DatabaseGateway, sql: &str) -> Vec<Vec<DatabaseValue>> {
    db.query(sql.into(), vec![], None, CLIENT.into())
        .unwrap()
        .rows
}
fn agent(fixture: &Fixture, command: Value) -> Value {
    json!({"operation":"workspaceAgent","handle":fixture.workspace,"projectId":fixture.project,"command":command})
}
fn read(fixture: &Fixture, kind: &str, id: &str) -> Value {
    success(agent(
        fixture,
        json!({"action":"readProse","target":{"kind":kind,"id":id}}),
    ))
}
fn call(id: &str) -> Value {
    json!({"sessionId":"agent-session","turnId":"turn-1","callId":id})
}
fn edit(handle: u64, text: &str) {
    let current = state(handle);
    success(
        json!({"operation":"documentReplace","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":0,"length":0},"text":text}}),
    );
}

#[test]
fn workspace_agent_reads_and_applies_revisions_through_owners() {
    let fixture = Fixture::new();
    let first = fixture.open(0)["handle"].as_u64().unwrap();
    let db = gateway(first);
    let open = fixture.chapters[0].clone();
    let closed = fixture.chapters[1].clone();
    edit(first, "雨夜里钟声响起。\n她推开北塔的门。");
    // An open body reads its live text, including unsaved input.
    let live = read(&fixture, "chapter", &open);
    assert_eq!(
        (live["text"].as_str(), live["live"].as_bool()),
        (Some("雨夜里钟声响起。\n她推开北塔的门。"), Some(true))
    );
    assert_eq!(read(&fixture, "chapter", &closed)["live"], false);
    // The styled projection reads the same bodies without writing.
    let projection = success(agent(
        &fixture,
        json!({"action":"readProjection","target":{"kind":"chapter","id":open}}),
    ));
    assert_eq!(projection["live"], true);
    assert_eq!(
        projection["projection"]["text"],
        "雨夜里钟声响起。\n她推开北塔的门。"
    );
    assert_eq!(
        projection["projection"]["blocks"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        success(agent(
            &fixture,
            json!({"action":"readProjection","target":{"kind":"chapter","id":closed}}),
        ))["live"],
        false
    );
    // Applying to the open owner saves the author's edit as theirs, then the
    // revision as the Agent's, and returns the owner's new state.
    let applied = success(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":open},
        "changes":[{"currentText":"钟声响起","revisedText":"钟声悠悠响起"},{"currentText":"北塔","revisedText":"钟楼"}],
        "agent":call("call-1")}),
    ));
    assert_eq!(
        (applied["applied"].as_u64(), applied["handle"].as_u64()),
        (Some(2), Some(first))
    );
    assert_eq!(
        applied["document"]["projection"]["text"],
        "雨夜里钟声悠悠响起。\n她推开钟楼的门。"
    );
    assert_eq!(
        state(first)["projection"]["text"],
        "雨夜里钟声悠悠响起。\n她推开钟楼的门。"
    );
    let doc = format!("node-content:{open}");
    let sources: Vec<Vec<DatabaseValue>> = query(&db, &format!(
        "SELECT source_kind,agent_session_id,agent_turn_id,agent_call_id FROM yjs_document_revision_provenance WHERE document_id='{doc}' ORDER BY revision DESC LIMIT 3"));
    let agent_row = vec![
        DatabaseValue::Text("agent".into()),
        DatabaseValue::Text("agent-session".into()),
        DatabaseValue::Text("turn-1".into()),
        DatabaseValue::Text("call-1".into()),
    ];
    assert_eq!(
        (&sources[0], &sources[1]),
        (&agent_row, &agent_row),
        "one Agent revision per change"
    );
    assert_eq!(
        sources[2][0],
        DatabaseValue::Text("user".into()),
        "the author's input stays the author's"
    );
    // Each change is one undo step in the open editor; changes apply from
    // the end of the text, so undo reverts the earliest one first.
    success(json!({"operation":"documentUndo","handle":first}));
    assert_eq!(
        state(first)["projection"]["text"],
        "雨夜里钟声响起。\n她推开钟楼的门。"
    );
    success(json!({"operation":"documentRedo","handle":first}));
    // A closed body is revised by a temporary owner and stays closed.
    edit_closed(&fixture, &closed, "北风。北风。");
    let revised = success(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":closed},
        "changes":[{"currentText":"北风","revisedText":"南风","allOccurrences":true}],"agent":call("call-2")}),
    ));
    assert_eq!(
        (revised["applied"].as_u64(), revised["handle"].clone()),
        (Some(2), Value::Null)
    );
    assert_eq!(read(&fixture, "chapter", &closed)["text"], "南风。南风。");
    // Refusals write nothing.
    let before = query(&db, "SELECT count(*) FROM sync_change_set");
    for (changes, message) in [
        (
            json!([{"currentText":"不存在","revisedText":"x"}]),
            "找不到",
        ),
        (
            json!([{"currentText":"南风","revisedText":"x"}]),
            "出现了 2 次",
        ),
        (json!([{"currentText":"","revisedText":"x"}]), "不能为空"),
    ] {
        let error = rejected(agent(
            &fixture,
            json!({"action":"applyChanges","target":{"kind":"chapter","id":closed},
            "changes":changes,"agent":call("call-3")}),
        ));
        assert!(error.contains(message), "{error}");
    }
    let overlap = rejected(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":closed},
        "changes":[{"currentText":"南风。南风","revisedText":"x"},{"currentText":"风。","revisedText":"y","allOccurrences":true}],
        "agent":call("call-4")}),
    ));
    assert!(overlap.contains("重叠"), "{overlap}");
    assert_eq!(query(&db, "SELECT count(*) FROM sync_change_set"), before);
    assert_eq!(read(&fixture, "chapter", &closed)["text"], "南风。南风。");
    // Appending writes new paragraphs at the end, also into an empty body.
    let created = success(
        json!({"operation":"workspaceCreateChapter","handle":fixture.workspace,
        "projectId":fixture.project,"title":"新章"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string();
    for (text, id) in [("第一段\n第二段", "call-5"), ("第三段", "call-6")] {
        success(agent(
            &fixture,
            json!({"action":"applyChanges","target":{"kind":"chapter","id":created},
            "changes":[{"currentText":"","revisedText":text,"append":true}],"agent":call(id)}),
        ));
    }
    assert_eq!(
        read(&fixture, "chapter", &created)["text"],
        "第一段\n第二段\n第三段"
    );
    for changes in [
        json!([{"currentText":"第一段","revisedText":"x","append":true}]),
        json!([{"currentText":"","revisedText":"x","append":true},{"currentText":"第二段","revisedText":"y"}]),
        json!([{"currentText":"","revisedText":"  ","append":true}]),
    ] {
        rejected(agent(
            &fixture,
            json!({"action":"applyChanges","target":{"kind":"chapter","id":created},
            "changes":changes,"agent":call("call-7")}),
        ));
    }
    assert_eq!(
        read(&fixture, "chapter", &created)["text"],
        "第一段\n第二段\n第三段"
    );
    assert!(rejected(agent(
        &fixture,
        json!({"action":"readProse","target":{"kind":"comment","id":"x"}})
    ))
    .contains("do not support"));
    assert!(
        rejected(agent(
            &fixture,
            json!({"action":"readProse","target":{"kind":"chapter","id":"missing"}})
        ))
        .len()
            > 0
    );
    fixture.close();
}

/// Writes a closed chapter's body through a short-lived owner.
fn edit_closed(fixture: &Fixture, chapter: &str, text: &str) {
    let index = fixture
        .chapters
        .iter()
        .position(|id| id == chapter)
        .unwrap();
    let handle = fixture.open(index)["handle"].as_u64().unwrap();
    edit(handle, text);
    success(
        json!({"operation":"workspaceCloseChapter","handle":fixture.workspace,"projectId":fixture.project,"chapterId":chapter}),
    );
}

#[test]
fn workspace_agent_revisions_replace_only_the_changed_span() {
    let fixture = Fixture::new();
    let handle = fixture.open(0)["handle"].as_u64().unwrap();
    let chapter = fixture.chapters[0].clone();
    edit(handle, "他终于说出了真相。");
    let current = state(handle);
    success(json!({"operation":"documentFormat","handle":handle,"edit":{
        "revision":current["projection"]["revision"],"range":{"location":6,"length":2},"action":"bold"}}));
    let applied = success(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":chapter},
        "changes":[{"currentText":"他终于说出了真相。","revisedText":"他终于说出真相。"}],
        "agent":call("call-narrow")}),
    ));
    let block = &applied["document"]["projection"]["blocks"][0];
    assert_eq!(
        applied["document"]["projection"]["text"],
        "他终于说出真相。"
    );
    // 真相 keeps its bold; the text before it stays plain.
    let runs = block["runs"].as_array().unwrap();
    let bold: Vec<_> = runs
        .iter()
        .filter(|run| run["attributes"].get("bold").is_some())
        .map(|run| {
            (
                run["range"]["location"].as_u64(),
                run["range"]["length"].as_u64(),
            )
        })
        .collect();
    assert_eq!(bold, vec![(Some(5), Some(2))]);
    // An unchanged revision writes nothing and applies nothing.
    let unchanged = success(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":chapter},
        "changes":[{"currentText":"真相","revisedText":"真相"}],"agent":call("call-same")}),
    ));
    assert_eq!(unchanged["applied"], 0);
    // Surrogate pairs are never split.
    edit(handle, "🙂🙂");
    let emoji = success(agent(
        &fixture,
        json!({"action":"applyChanges","target":{"kind":"chapter","id":chapter},
        "changes":[{"currentText":"🙂🙂","revisedText":"🙂😀"}],"agent":call("call-emoji")}),
    ));
    assert!(emoji["document"]["projection"]["text"]
        .as_str()
        .unwrap()
        .starts_with("🙂😀"));
    fixture.close();
}
