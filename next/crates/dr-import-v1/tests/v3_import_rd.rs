//! RD's import rules (`kernel-v5.md` §19 「导入 0.1」): comments follow the
//! author's automatic-link setting, projected comments copy their prose line,
//! and each relation not brought over is counted once, by kind.

mod common;

use common::{v3_fixture as fixture, *};
use dr_doc::peer::random_device_peer;
use dr_doc::v3::BookDocV3;
use dr_doc::v3::novel::MOD_PROSE;
use dr_import_v1::gate::Accept;
use dr_import_v1::receipt::Receipt;
use dr_import_v1::run::{self, Options, Outcome};
use dr_import_v1::v3::MappingChoices;
use dr_model::id::{BlockId, BookId, CommentId, EntryId};
use dr_model::kind::ProjectionKind;
use dr_model::v3::{EntryTextLink, LinkedText};
use dr_samples::v3 as adapter;
use dr_store::{Library, LibraryOptions};
use serde_json::json;

fn eid(s: &str) -> EntryId {
    EntryId::parse(s).unwrap()
}

fn link(start: usize, end: usize, entry: &str) -> EntryTextLink {
    EntryTextLink {
        start,
        end,
        entry: eid(entry),
    }
}

fn import(old: &Old, auto_entity_links: bool) -> (tempfile::TempDir, Receipt, BookDocV3) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    let mut opts = Options::new("k3-v3-test");
    opts.v3 = MappingChoices {
        auto_entity_links,
        ..v3_choices()
    };
    opts.old_root = Some(old.root.clone());
    opts.index = false;
    opts.accept = Accept::EVERYTHING;
    let (outcome, _) = run::import(&old.db, &root, &opts).unwrap();
    let Outcome::Imported(receipt) = outcome else {
        panic!("expected imported");
    };
    let lib = open(&root);
    let bytes = lib
        .load_copy(&format!("book:{BOOK}"))
        .unwrap()
        .export(loro::ExportMode::Snapshot)
        .unwrap();
    lib.close().unwrap();
    let book =
        BookDocV3::load(BookId::parse(BOOK).unwrap(), random_device_peer(), &[bytes]).unwrap();
    (temp, *receipt, book)
}

fn open(root: &std::path::Path) -> Library {
    let start = std::time::Instant::now();
    loop {
        match Library::open(root, LibraryOptions::new("k3-v3-test")) {
            Ok(lib) => return lib,
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn workspace(root: &std::path::Path) -> dr_workspace::Workspace {
    let start = std::time::Instant::now();
    loop {
        match dr_workspace::Workspace::open_dir(root, "k3-v3-test") {
            Ok(ws) => return ws,
            Err(error)
                if error.to_string().contains("already open") && start.elapsed().as_secs() < 5 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn comment_text(text: &str) -> String {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
        .to_string()
}

/// A note comment holding an element's name is linked when the author's
/// setting is on, and stays plain text when it is off.
#[test]
fn imported_comments_link_names_only_when_the_setting_is_on() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.execute(
        "UPDATE comment SET body_json = ?2 WHERE id = ?1",
        rusqlite::params![BLOCK_COMMENT, comment_text("引文里的阿Q要核对")],
    )
    .unwrap();
    drop(c);
    let id = CommentId::parse(BLOCK_COMMENT).unwrap();
    for (on, links) in [(true, vec![link(4, 6, ELEMENT)]), (false, vec![])] {
        let (_temp, _, book) = import(&old, on);
        assert_eq!(
            book.view().comment(&id).unwrap().body,
            LinkedText {
                text: "引文里的阿Q要核对".into(),
                links,
            },
            "auto_entity_links = {on}"
        );
    }
}

/// Checklist and marker comments take their words and links from their
/// prose line, not from the names in them, so the first projection on the
/// imported library has nothing to write.
#[test]
fn projected_comments_copy_their_line_and_the_first_projection_writes_nothing() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    let element = |id: &str| json!({"type":"entityLink","attrs":{"targetKind":"element","targetId":id,"targetBlockId":null}});
    // 阿Q is an element's name, unlinked on the line; 告示 and 年纪 are
    // linked to an element the names would never give.
    let note = json!({"type":"doc","content":[{"type":"taskList","attrs":{"id":"tl"},"content":[
        {"type":"taskItem","attrs":{"id":"ti1","checked":false,"todoId":NOTE_TODO},"content":[
            {"type":"paragraph","attrs":{"id":"tp1"},"content":[{"type":"text","text":"核对阿Q的称呼"}]}]},
        {"type":"taskItem","attrs":{"id":"ti2","checked":true},"content":[
            {"type":"paragraph","attrs":{"id":"tp2"},"content":[
                {"type":"text","text":"抄录"},
                {"type":"text","text":"告示","marks":[element(fixture::ELEMENT_OTHER)]}]}]}]}]});
    c.execute(
        "UPDATE library_item SET body_json = ?2 WHERE id = ?1",
        rusqlite::params![NOTE, note.to_string()],
    )
    .unwrap();
    c.execute(
        "UPDATE comment SET body_json = ?2 WHERE id = ?1",
        rusqlite::params![NOTE_TODO, comment_text("核对阿Q的称呼")],
    )
    .unwrap();
    let chapter = CHAPTER_JSON.replacen(
        r#"{"type":"text","text":"TODO: 查一查赵太爷的年纪"}"#,
        &format!(
            r#"{{"type":"text","text":"TODO: 查一查阿Q的"}},{{"type":"text","text":"年纪","marks":[{}]}}"#,
            element(fixture::ELEMENT_OTHER)
        ),
        1,
    );
    assert_ne!(chapter, CHAPTER_JSON);
    c.execute(
        "UPDATE node_content SET content_json = ?2 WHERE node_id = ?1",
        rusqlite::params![CHAPTER, chapter],
    )
    .unwrap();
    c.execute(
        "UPDATE comment SET body_json = ?2 WHERE id = ?1",
        rusqlite::params![MARKER_TODO, comment_text("查一查阿Q的年纪")],
    )
    .unwrap();
    drop(c);

    let (temp, _, book) = import(&old, true);
    let note_doc = adapter::body_id(NOTE, MOD_PROSE);
    let chapter_doc = adapter::body_id(CHAPTER, MOD_PROSE);
    let projected = |kind: ProjectionKind, doc: &dr_model::DocId, block: &str| {
        let id = CommentId::for_projection(&kind, doc, &BlockId::parse(block).unwrap());
        book.view()
            .comment_body_raw(&id)
            .expect("projected comment")
    };
    assert_eq!(
        projected(ProjectionKind::NoteTask, &note_doc, "tp1"),
        LinkedText::plain("核对阿Q的称呼")
    );
    assert_eq!(
        projected(ProjectionKind::NoteTask, &note_doc, "tp2"),
        LinkedText {
            text: "抄录告示".into(),
            links: vec![link(2, 4, fixture::ELEMENT_OTHER)],
        }
    );
    assert_eq!(
        projected(ProjectionKind::Marker, &chapter_doc, "p2"),
        LinkedText {
            text: "查一查阿Q的年纪".into(),
            links: vec![link(6, 8, fixture::ELEMENT_OTHER)],
        }
    );

    let ws = workspace(&temp.path().join("library"));
    let version =
        |ws: &dr_workspace::Workspace| ws.observe(&format!("book:{BOOK}")).unwrap().version;
    let before = version(&ws);
    for (doc, markers) in [
        (&note_doc, json!([])),
        (
            &chapter_doc,
            json!([{"block":"p2","task":"查一查阿Q的年纪"}]),
        ),
    ] {
        let out = ws
            .call(
                &dr_workspace::Actor::User,
                "comment.project",
                json!({"doc":doc.to_string(),"tasks":[],"markers":markers}),
            )
            .unwrap()["output"]
            .clone();
        assert_eq!(
            out,
            json!({"created":[],"removed":[],"waiting":[]}),
            "{doc}"
        );
    }
    assert_eq!(version(&ws), before, "the first projection writes nothing");
    ws.close();
}

/// Each relation that does not come over is counted once, under the first of
/// its ends that cannot (the source end first); the built-in 「关联」's
/// entry–entry relations are their own kind; each is kept in the receipt.
#[test]
fn each_relation_not_brought_over_is_counted_once_by_kind_and_kept_in_the_receipt() {
    let old = fixture::build();
    let c = rusqlite::Connection::open(&old.db).unwrap();
    c.pragma_update(None, "foreign_keys", false).unwrap();
    // An image–patch relation under an author's type: one relation, counted
    // as the image end's.
    c.execute(
        "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES ('rel-image-patch', ?1, 'library_item', ?2, 'patch', ?3, ?4, ?5, ?5)",
        rusqlite::params![BOOK, IMAGE, PATCH, REL_TYPE, T0],
    )
    .unwrap();
    // A second built-in entry–entry relation (the fixture has NOTE → CHAPTER).
    let generic = format!("system:generic-association:{BOOK}");
    c.execute(
        "INSERT INTO entity_relation (id, project_id, from_kind, from_id, to_kind, to_id, relation_type_id, created_at, updated_at) VALUES ('rel-builtin-entries', ?1, 'element', ?2, 'node', ?3, ?4, ?5, ?5)",
        rusqlite::params![BOOK, ELEMENT, CHAPTER, generic, T0],
    )
    .unwrap();
    drop(c);
    let (temp, receipt, book) = import(&old, true);
    let rec = receipt.books.iter().find(|b| b.book_id == BOOK).unwrap();
    let count = |code: &str| rec.notes.0.get(code).copied();
    assert_eq!(count("relation-image-end-dropped"), Some(1));
    assert_eq!(
        count("relation-patch-end-dropped"),
        Some(1),
        "rel-patch only"
    );
    assert_eq!(count("relation-todo-end-dropped"), Some(1));
    assert_eq!(count("relation-built-in-entries-dropped"), Some(2));
    assert_eq!(count("built-in-relation-type-dropped"), Some(1));
    let dropped: std::collections::BTreeMap<&str, serde_json::Value> = receipt
        .originals
        .iter()
        .filter(|(c, _, f, _)| c == "relations" && f == "dropped")
        .map(|(_, id, _, json)| (id.as_str(), serde_json::from_str(json).unwrap()))
        .collect();
    assert_eq!(
        dropped.keys().copied().collect::<Vec<_>>(),
        [
            "rel-2",
            "rel-builtin-entries",
            "rel-image-patch",
            "rel-material",
            "rel-patch"
        ]
    );
    assert_eq!(
        dropped["rel-image-patch"],
        json!({
            "reason":"relation-image-end-dropped","relationType":REL_TYPE,
            "from":{"kind":"library_item","id":IMAGE},"to":{"kind":"patch","id":PATCH},
            "createdAt":T0,
        })
    );
    assert_eq!(
        dropped["rel-material"]["reason"],
        "relation-built-in-entries-dropped"
    );
    // The author's relation between two entries came over.
    assert_eq!(book.view().relations().len(), 1);
    let summary =
        std::fs::read_to_string(temp.path().join("library/import-v1/summary.md")).unwrap();
    assert!(
        summary.contains("内置的「关联」下两头都是条目的关系没有导入（2 处"),
        "{summary}"
    );
    assert!(
        summary.contains("一头是图片的关系没有导入（1 处"),
        "{summary}"
    );
}
