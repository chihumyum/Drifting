use super::*;
use dr_model::id::MemoryId;
use dr_testkit::seed::{self, Preset};
use dr_workspace::{Actor, Workspace};
use serde_json::json;

struct Fixture {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: BookId,
    text: String,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_dir(dir.path(), "m30-memory-test").unwrap();
        let seed = seed::generate_v3(Preset::Tiny, seed::DEFAULT_SEED).unwrap();
        let book = seed.books[0].book_id().clone();
        let text = seed.books[0]
            .groups()
            .values()
            .flatten()
            .find(|s| s.chars().count() > 20)
            .unwrap()
            .clone();
        seed.write_to(ws.library()).unwrap();
        Self {
            _dir: dir,
            ws,
            book,
            text,
        }
    }

    fn add(&self, body: &str, actor: &Actor) -> MemoryId {
        let out = self
            .ws
            .call(actor, "memory.add", json!({"book":self.book,"body":body}))
            .unwrap();
        MemoryId::parse(out["output"]["id"].as_str().unwrap()).unwrap()
    }
}
#[test]
fn chunked_content_reopens_without_truncation_and_clear_has_no_aba() {
    let f = Fixture::new();
    let lib = f.ws.library();
    let large = f.text.repeat(1_400_000 / f.text.len() + 1);
    let first = replace(lib, &f.book, 0, &large, UpdatedBy::Author).unwrap();
    assert_eq!(first.content_md, large);
    let entries = lib.local_entries(SCOPE, Some(f.book.as_str())).unwrap();
    assert!(entries.len() > 5);
    assert!(entries.iter().all(|e| e.value.len() < 1_048_576));
    let reopened = dr_store::Library::open_read_only(
        f._dir.path(),
        dr_workspace::library_options("m30-memory-readonly"),
    )
    .unwrap();
    assert_eq!(load(&reopened, &f.book).unwrap(), first);
    drop(reopened);
    let cleared = clear(lib, &f.book, first.revision, UpdatedBy::Author).unwrap();
    assert!(!cleared.exists);
    assert_eq!(cleared.revision, 2);
    assert!(matches!(
        replace(lib, &f.book, 0, &f.text, UpdatedBy::Agent),
        Err(MemoryError::Conflict { actual: 2, .. })
    ));
    let next = replace(lib, &f.book, 2, &f.text, UpdatedBy::Agent).unwrap();
    assert_eq!(next.revision, 3);
}
#[test]
fn simultaneous_cas_has_one_winner_and_edit_sequence_is_atomic() {
    let f = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let mut jobs = Vec::new();
    for by in [UpdatedBy::Author, UpdatedBy::Agent] {
        let lib = f.ws.library().clone();
        let book = f.book.clone();
        let text = f.text.clone();
        let barrier = barrier.clone();
        jobs.push(std::thread::spawn(move || {
            barrier.wait();
            replace(&lib, &book, 0, &text, by)
        }));
    }
    let values: Vec<_> = jobs.into_iter().map(|j| j.join().unwrap()).collect();
    assert_eq!(values.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        values
            .iter()
            .filter(|r| matches!(r, Err(MemoryError::Conflict { .. })))
            .count(),
        1
    );
    let old = load(f.ws.library(), &f.book).unwrap();
    let edits = [
        Edit {
            old_text: f.text.clone(),
            new_text: EMPTY_MARKDOWN.into(),
        },
        Edit {
            old_text: f.text.clone(),
            new_text: String::new(),
        },
    ];
    assert!(
        edit(
            f.ws.library(),
            &f.book,
            old.revision,
            &edits,
            UpdatedBy::Agent
        )
        .is_err()
    );
    assert_eq!(load(f.ws.library(), &f.book).unwrap(), old);
}
#[test]
fn missing_extra_or_changed_chunks_fail_closed_without_erasing_them() {
    for damage in 0..3 {
        let f = Fixture::new();
        let lib = f.ws.library();
        replace(lib, &f.book, 0, &f.text, UpdatedBy::Author).unwrap();
        let chunk = format!("{}/chunk/{:016x}", f.book, 0);
        lib.local_write(|tx| match damage {
            0 => tx.remove_state(SCOPE, &chunk).map(|_| ()),
            1 => tx.set_state(
                SCOPE,
                &format!("{}/chunk/{:016x}", f.book, 1),
                &f.text,
                Some(f.book.as_str()),
            ),
            _ => tx.set_state(SCOPE, &chunk, EMPTY_MARKDOWN, Some(f.book.as_str())),
        })
        .unwrap();
        let rows = lib.local_entries(SCOPE, Some(f.book.as_str())).unwrap();
        assert!(matches!(load(lib, &f.book), Err(MemoryError::Corrupt)));
        assert!(matches!(
            replace(lib, &f.book, 1, &f.text, UpdatedBy::Author),
            Err(MemoryError::Corrupt)
        ));
        assert_eq!(
            lib.local_entries(SCOPE, Some(f.book.as_str())).unwrap(),
            rows
        );
    }
}
#[test]
fn pagination_uses_characters_and_explicit_revisions_without_storage_cap() {
    let f = Fixture::new();
    let lib = f.ws.library();
    let text = f.text.repeat(3000);
    let first = replace(lib, &f.book, 0, &text, UpdatedBy::Author).unwrap();
    let mut collected = String::new();
    let mut start = 0;
    loop {
        let page = read_page(lib, &f.book, start, 7, Some(first.revision)).unwrap();
        assert_eq!(page.start, start);
        assert!(page.content_md.chars().count() <= 7);
        collected.push_str(&page.content_md);
        start = page.end;
        if !page.has_more {
            break;
        }
        // Enough boundary checks without rereading megabytes thousands of times.
        if start > 35 {
            let tail =
                read_page(lib, &f.book, start, MAX_PAGE_CHARS, Some(first.revision)).unwrap();
            assert_eq!(tail.total_chars, text.chars().count());
            break;
        }
    }
    assert_eq!(collected, text.chars().take(start).collect::<String>());
    assert!(read_page(lib, &f.book, 0, MAX_PAGE_CHARS + 1, None).is_err());
    clear(lib, &f.book, first.revision, UpdatedBy::Author).unwrap();
    assert!(matches!(
        read_page(lib, &f.book, 0, 7, Some(first.revision)),
        Err(MemoryError::Conflict { .. })
    ));
}
#[test]
fn notices_rearm_on_shrink_and_never_remove_text() {
    let f = Fixture::new();
    let lib = f.ws.library();
    let mut revision = 0;
    for (tokens, first, second) in [
        (20_000, false, false),
        (20_001, true, false),
        (40_001, true, false),
        (80_001, true, true),
        (1, false, false),
        (20_001, true, false),
    ] {
        // Shared corpus characters, repeated. One non-ASCII scalar is the
        // estimator's unit; use a generated CJK character, not a new corpus.
        let c = f.text.chars().find(|c| !c.is_ascii()).unwrap();
        let text = c.to_string().repeat(tokens);
        let snapshot = replace(lib, &f.book, revision, &text, UpdatedBy::Author).unwrap();
        revision = snapshot.revision;
        assert_eq!(snapshot.approx_tokens, tokens as u64);
        assert_eq!(take_notice(lib, &f.book, revision).unwrap(), first);
        assert_eq!(take_notice(lib, &f.book, revision).unwrap(), second);
        assert_eq!(load(lib, &f.book).unwrap().content_md, text);
    }
}
#[test]
fn agent_receipt_is_atomic_idempotent_and_bound_to_request() {
    let f = Fixture::new();
    let lib = f.ws.library();
    let actor = Actor::Agent {
        session: "memory-session".into(),
        turn: 1,
        call: "edit-1".into(),
    };
    let edits = [Edit {
        old_text: EMPTY_MARKDOWN.into(),
        new_text: f.text.clone(),
    }];
    lib.local_write(|tx|{tx.execute_batch("CREATE TRIGGER fail_memory_receipt BEFORE INSERT ON local_state WHEN NEW.scope='agent-memory' AND NEW.key LIKE '%/receipt/%' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;")?;Ok(())}).unwrap();
    assert!(super::store::edit_once(lib, &f.book, &actor, 0, &edits).is_err());
    assert_eq!(load(lib, &f.book).unwrap().revision, 0);
    assert!(
        lib.local_entries(SCOPE, Some(f.book.as_str()))
            .unwrap()
            .is_empty()
    );
    lib.local_write(|tx| {
        tx.execute_batch("DROP TRIGGER fail_memory_receipt")?;
        Ok(())
    })
    .unwrap();
    let result = super::store::edit_once(lib, &f.book, &actor, 0, &edits).unwrap();
    clear(lib, &f.book, result.revision, UpdatedBy::Author).unwrap();
    assert_eq!(
        super::store::edit_once(lib, &f.book, &actor, 0, &edits).unwrap(),
        result
    );
    assert_eq!(load(lib, &f.book).unwrap().revision, 2);
    assert!(super::store::edit_once(lib, &f.book, &actor, 1, &edits).is_err());
}
#[test]
fn trashed_and_deleted_book_cannot_recreate_local_memory() {
    let f = Fixture::new();
    let lib = f.ws.library();
    replace(lib, &f.book, 0, &f.text, UpdatedBy::Author).unwrap();
    f.ws.call(&Actor::User, "book.trash", json!({"book":f.book}))
        .unwrap();
    assert!(load(lib, &f.book).is_err());
    assert!(replace(lib, &f.book, 1, &f.text, UpdatedBy::Author).is_err());
    f.ws.call(&Actor::User, "book.purge", json!({"book":f.book}))
        .unwrap();
    assert!(
        lib.local_entries(SCOPE, Some(f.book.as_str()))
            .unwrap()
            .is_empty()
    );
    assert!(replace(lib, &f.book, 0, &f.text, UpdatedBy::Author).is_err());
}
#[test]
fn imported_project_memory_is_plain_active_raw_body_and_keeps_unknown_status_inert() {
    let f = Fixture::new();
    let id = MemoryId::new_v7();
    let body = format!("  {}\n\n{}  \n", f.text, f.text);
    let edit = |status: &str, deleted: Option<dr_model::Timestamp>| {
        let status = status.to_owned();
        let body = body.clone();
        let book = f.book.clone();
        let id = id.clone();
        f.ws.library()
            .open_doc(&format!("book:{book}"), dr_store::OpenDoc::Existing)
            .unwrap()
            .write(dr_store::Origin::Import, move |doc| {
                let b = dr_doc::v3::BorrowedBookV3::new(doc, &book).unwrap();
                let mut t = b.txn();
                for old in t.view().memory() {
                    t.memory(&old.id)
                        .unwrap()
                        .deleted_at(Some(dr_model::Timestamp(1)))
                        .unwrap();
                }
                t.memory(&id)
                    .unwrap()
                    .body(&body)
                    .unwrap()
                    .kind(&dr_model::kind::MemoryKind::from("directive"))
                    .unwrap()
                    .source(&dr_model::kind::MemorySource::from("author"))
                    .unwrap()
                    .status(&dr_model::kind::MemoryStatus::from(status.as_str()))
                    .unwrap()
                    .deleted_at(deleted)
                    .unwrap();
            })
            .unwrap();
    };
    edit("active", None);
    let snapshot = project(&f.ws, &f.book).unwrap();
    assert_eq!(snapshot.markdown, format!("# PROJECT_MEMORY.md\n\n{body}"));
    assert_eq!(snapshot.entries[0].body, body);
    edit("future", None);
    let snapshot = project(&f.ws, &f.book).unwrap();
    assert_eq!(snapshot.entries[0].status, "future");
    assert!(!snapshot.entries[0].active());
    assert!(!snapshot.markdown.contains(&f.text));
    edit("dismissed", None);
    assert!(!project(&f.ws, &f.book).unwrap().markdown.contains(&f.text));
    edit("active", Some(dr_model::Timestamp(1)));
    assert!(project(&f.ws, &f.book).unwrap().entries.is_empty());
}

#[test]
fn project_memory_is_plain_active_raw_body_and_shared_author_agent_data() {
    let f = Fixture::new();
    // This fixture starts with the seed's standing project guidance.
    for entry in project(&f.ws, &f.book).unwrap().entries {
        f.ws.call(
            &Actor::User,
            "memory.remove",
            json!({"book":f.book,"id":entry.id}),
        )
        .unwrap();
    }
    let body = format!("  {}\n\n{}  \n", f.text, f.text);
    let actor = Actor::Agent {
        session: "project-memory-session".into(),
        turn: 1,
        call: "add".into(),
    };
    let id = f.add(&body, &actor);
    let snapshot = project(&f.ws, &f.book).unwrap();
    assert_eq!(snapshot.markdown, format!("# PROJECT_MEMORY.md\n\n{body}"));
    assert_eq!(snapshot.entries[0].id, id);
    assert_eq!(snapshot.entries[0].body, body);
    f.ws.call(
        &Actor::User,
        "memory.update",
        json!({"book":f.book,"id":id,"body":f.text}),
    )
    .unwrap();
    assert_eq!(project(&f.ws, &f.book).unwrap().entries[0].body, f.text);
    f.ws.call(
        &Actor::User,
        "memory.update",
        json!({"book":f.book,"id":id,"status":"dismissed"}),
    )
    .unwrap();
    let dismissed = project(&f.ws, &f.book).unwrap();
    assert_eq!(dismissed.entries.len(), 1);
    assert!(!dismissed.markdown.contains(&f.text));
    f.ws.call(
        &Actor::User,
        "memory.remove",
        json!({"book":f.book,"id":id}),
    )
    .unwrap();
    assert!(project(&f.ws, &f.book).unwrap().entries.is_empty());
    let unknown = ProjectEntry {
        id,
        body: f.text,
        kind: "directive".into(),
        status: "future".into(),
        source: "author".into(),
        removed: false,
    };
    assert!(!unknown.active());
}
