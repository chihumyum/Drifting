//! M20's readings over a real library: a small synthetic book with entity
//! links in its prose, read the way the Stats tab reads it.

use dr_view_stats::detail::{self, Detail, Statuses};
use dr_workspace::{Actor, NavTarget, Workspace, WorkspaceOptions};
use serde_json::{Value, json};

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).expect(name)["output"].clone()
}

fn id(v: Value) -> String {
    v["id"].as_str().unwrap().to_owned()
}

/// Links `ranges` of `doc` to element `target`.
fn link(ws: &Workspace, doc: &str, target: &str, ranges: &[(usize, usize)]) {
    let link = dr_model::prose::EntityLink {
        target: target.to_owned(),
        kind: dr_model::kind::EntityKind::Element,
        block: None,
        end_block: None,
    };
    let ranges = ranges.to_vec();
    ws.prose_session(doc)
        .unwrap()
        .edit(move |t| {
            for (start, end) in ranges {
                t.link_entity(start..end, &link)?;
            }
            Ok(())
        })
        .unwrap();
}

struct Book {
    ws: Workspace,
    book: String,
    people: String,
    anna: String,
    ben: String,
    bell: String,
    line: String,
    one: String,
    two: String,
    _dir: tempfile::TempDir,
}

fn book() -> Book {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(
        dir.path().join("library"),
        dr_workspace::library_options("0.2.0-dev"),
    )
    .unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = id(out(&ws, "book.create", json!({"name": "慢钟"})));
    let people = id(out(
        &ws,
        "category.create",
        json!({"book": book, "name": "人物", "color": "#9B6A4F"}),
    ));
    let el = |name: &str| {
        id(out(
            &ws,
            "element.create",
            json!({"book": book, "name": name, "category": people}),
        ))
    };
    let (anna, ben, bell) = (el("安娜"), el("本"), el("钟"));
    let line = id(out(
        &ws,
        "storyline.create",
        json!({"book": book, "name": "修理单"}),
    ));
    let one = id(out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "一", "storyline": line,
               "text": "安娜说：「走吧。」\n安娜和本。"}),
    ));
    let two = id(out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "二", "text": "本走了。"}),
    ));
    let three = id(out(
        &ws,
        "chapter.create",
        json!({"book": book, "title": "三"}),
    ));
    out(
        &ws,
        "chapter.update",
        json!({"book": book, "id": two, "status": "finished"}),
    );
    out(
        &ws,
        "chapter.update",
        json!({"book": book, "id": three, "status": "discarded"}),
    );
    out(
        &ws,
        "act.create",
        json!({"book": book, "name": "第一幕", "start_chapter": one, "color": "#3A6EA5"}),
    );
    link(&ws, &format!("node:{one}"), &anna, &[(0, 2), (10, 12)]);
    link(&ws, &format!("node:{one}"), &ben, &[(13, 14)]);
    link(&ws, &format!("node:{two}"), &ben, &[(0, 1)]);
    for d in ws.library().docs(Some(&book), None).unwrap() {
        ws.library().reindex_doc(&d.doc_id).unwrap();
    }
    Book {
        ws,
        book,
        people,
        anna,
        ben,
        bell,
        line,
        one,
        two,
        _dir: dir,
    }
}

fn load(b: &Book, target: NavTarget) -> detail::Loaded {
    detail::load(&b.ws, &b.book, &target)
        .unwrap()
        .expect("a live page")
}

fn names(rows: &[detail::Row]) -> Vec<(&str, u32)> {
    rows.iter().map(|r| (r.name.as_str(), r.count)).collect()
}

#[test]
fn a_chapter_reads_its_storyline_shape_and_elements() {
    let b = book();
    let got = load(&b, NavTarget::Chapter(b.one.parse().unwrap()));
    assert_eq!(got.name, "一");
    assert_eq!(got.doc.as_deref(), Some(format!("node:{}", b.one).as_str()));
    let Detail::Page(d) = got.detail else {
        panic!("{:?}", got.detail)
    };
    assert_eq!(d.storyline.map(|(_, n)| n).as_deref(), Some("修理单"));
    assert_eq!(d.number, Some(1));
    assert!(d.updated_at.is_some());
    assert_eq!((d.shape.paragraphs, d.shape.sentences), (2, 2));
    assert!((d.shape.dialogue - 3.0 / 14.0).abs() < 1e-6);
    assert_eq!(names(&d.elements), [("安娜", 2), ("本", 1)]);
}

#[test]
fn a_storyline_counts_its_chapters_and_core_elements() {
    let b = book();
    let Detail::Storyline(d) = load(&b, NavTarget::Storyline(b.line.parse().unwrap())).detail
    else {
        panic!()
    };
    assert_eq!((d.chapters, d.finished, d.draft, d.discarded), (1, 0, 1, 0));
    assert_eq!(names(&d.core), [("安娜", 2), ("本", 1)]);
}

#[test]
fn an_element_reads_what_mentions_it() {
    let b = book();
    let got = load(&b, NavTarget::Element(b.ben.parse().unwrap()));
    let Detail::Element(d) = got.detail else {
        panic!()
    };
    assert_eq!(d.category.map(|(_, n)| n).as_deref(), Some("人物"));
    let mut from: Vec<&str> = d.incoming.iter().map(|r| r.name.as_str()).collect();
    from.sort();
    assert_eq!(from, ["一", "二"]);
    assert!(d.incoming.iter().all(|r| (r.blocks, r.count) == (1, 1)));
    assert!(d.outgoing.is_empty());
}

#[test]
fn a_category_reads_its_health() {
    let b = book();
    let Detail::Category(d) = load(&b, NavTarget::Category(b.people.parse().unwrap())).detail
    else {
        panic!()
    };
    assert_eq!((d.elements, d.appeared), (3, 2));
    // 安娜 in one chapter, 本 in two.
    assert!((d.average - 1.5).abs() < 1e-6);
    assert_eq!(
        d.unappeared
            .iter()
            .map(|r| r.name.as_str())
            .collect::<Vec<_>>(),
        ["钟"]
    );
    let lines: Vec<(Option<String>, u32)> = d
        .storylines
        .into_iter()
        .map(|(l, n)| (l.map(|(_, name)| name), n))
        .collect();
    assert_eq!(lines, [(Some("修理单".to_owned()), 2), (None, 1)]);
    let _ = (&b.anna, &b.bell);
}

#[test]
fn materials_read_their_shape_or_their_file() {
    let b = book();
    let note = id(out(
        &b.ws,
        "material.create",
        json!({"book": b.book, "kind": "text", "title": "笔记", "text": "钟楼要修。\n买零件"}),
    ));
    b.ws.library()
        .reindex_doc(&format!("material:{note}"))
        .unwrap();
    let got = load(&b, NavTarget::Material(note.parse().unwrap()));
    assert_eq!(
        got.doc.as_deref(),
        Some(format!("material:{note}").as_str())
    );
    let Detail::Material(d) = got.detail else {
        panic!()
    };
    assert_eq!(d.kind, "text");
    assert_eq!(d.note.as_ref().map(|n| n.words), Some(7));
    assert_eq!(d.open_comments, 0);
    assert!(d.file.is_none());

    let sha = "a".repeat(64);
    out(
        &b.ws,
        "asset.put",
        json!({"book": b.book, "id": "asset-1", "kind": "image", "mime": "image/png",
               "size": 2048, "sha256": sha, "width": 640, "height": 480}),
    );
    let pic = id(out(
        &b.ws,
        "material.create",
        json!({"book": b.book, "kind": "image", "title": "钟面", "asset": "asset-1"}),
    ));
    out(
        &b.ws,
        "relation.create",
        json!({"book": b.book, "from": {"kind": "material", "id": pic},
               "to": {"kind": "element", "id": b.bell}}),
    );
    let got = load(&b, NavTarget::Material(pic.parse().unwrap()));
    assert_eq!(got.doc, None, "a file has no prose of its own");
    let Detail::Material(d) = got.detail else {
        panic!()
    };
    let file = d.file.expect("its asset");
    assert_eq!(
        (file.mime.as_str(), file.size, file.width, file.height),
        ("image/png", 2048, Some(640), Some(480))
    );
    assert_eq!(names(&d.related), [("钟", 0)]);
}

#[test]
fn the_whole_book_reads_acts_and_statuses() {
    let b = book();
    let got = load(&b, NavTarget::Book);
    assert_eq!(got.doc, None);
    let Detail::Book(d) = got.detail else {
        panic!()
    };
    assert_eq!(d.chapters.len(), 3);
    assert_eq!(d.acts.len(), 1);
    assert_eq!(d.acts[0].name, "第一幕");
    assert_eq!(d.acts[0].color.as_deref(), Some("#3A6EA5"));
    assert_eq!(d.acts[0].chapters.len(), 3);
    assert_eq!(
        d.statuses,
        Statuses {
            done: 1,
            draft: 1,
            todo: 0,
            discarded: 1
        }
    );
    let _ = &b.two;
}

#[test]
fn a_page_that_is_gone_reads_nothing() {
    let b = book();
    out(&b.ws, "chapter.trash", json!({"book": b.book, "id": b.one}));
    let target = NavTarget::Chapter(b.one.parse().unwrap());
    assert!(detail::load(&b.ws, &b.book, &target).unwrap().is_none());
}
