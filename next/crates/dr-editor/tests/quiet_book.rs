//! The editors follow the book's content. The writing-day recorder writes
//! once a minute and every saved entry checkpoint once, both to documents
//! beside the book (`stats:<book>`, `checkpoints:<book>`); neither changes
//! the book document, a name, a link target or a chapter, so neither makes an
//! open editor read its names again.

use std::time::{Duration, Instant};

use dr_editor::{BookEditor, ChapterEditor, EditorSettings};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{TestAppContext, VisualTestContext};
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    /// Two chapters: (entry id, prose document).
    chapters: Vec<(String, String)>,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "project.create", json!({"name": "Synthetic quiet"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let manuscript = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");
    let chapters = ["One", "Two"]
        .into_iter()
        .map(|title| {
            let id = out(
                &ws,
                "entry.create",
                json!({"book": book, "parent": manuscript, "template": "tpl-chapter",
                    "title": title, "bodies": {"mod-prose": "Synthetic text."}}),
            )["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let doc = format!("body:{id}/mod-prose");
            (id, doc)
        })
        .collect();
    Env {
        _dir: dir,
        ws,
        book,
        chapters,
    }
}

impl Env {
    fn version(&self) -> String {
        self.ws.version(&format!("book:{}", self.book)).unwrap()
    }

    /// Writes that change none of the book's content: this device's writing
    /// day (twice), another device's arriving by sync, and a checkpoint of
    /// each chapter. None of them is a commit to the book document: its
    /// version stays where it was.
    fn commits_that_are_not_content(&self) -> usize {
        let stats = format!("stats:{}", self.book);
        let mut commits = 0;
        let mut moved = |what: &str, before: String| {
            assert_eq!(self.version(), before, "{what} is no commit to the book");
            commits += 1;
        };
        for words in [40, 95] {
            let before = self.version();
            out(
                &self.ws,
                "writing_day.record",
                json!({"book": self.book, "device": "device-000000000000000000000001",
                    "day": "2026-11-12", "words": words}),
            );
            moved("a writing day", before);
        }
        let other = self.ws.library().load_copy(&stats).unwrap();
        let from = other.oplog_vv();
        other
            .get_map("writing_days")
            .insert("device-000000000000000000000002|2026-11-12", 310)
            .unwrap();
        other.commit();
        let before = self.version();
        assert!(
            self.ws
                .import_remote(
                    &stats,
                    Some(("stats", self.book.as_str())),
                    other.export(loro::ExportMode::updates(&from)).unwrap(),
                    &Actor::Sync,
                )
                .unwrap()
        );
        moved("another device's writing day", before);
        for (entry, _) in &self.chapters {
            let before = self.version();
            out(
                &self.ws,
                "entry_snapshot.capture",
                json!({"book": self.book, "entry": entry, "reason": "close"}),
            );
            moved("a saved checkpoint", before);
        }
        commits
    }
}

/// Lets the holder threads' events reach the window, several times over.
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..12 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
    cx.run_until_parked();
}

fn wait_for(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// (times the pickers dropped the book's names, times the paint layers read
/// them).
type Names = (usize, usize);

#[gpui::test]
fn a_chapter_editor_reads_its_names_again_for_content_only(cx: &mut TestAppContext) {
    let e = env();
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), e.chapters[0].1.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    let names = |cx: &mut VisualTestContext| -> Names {
        view.read_with(cx, |v, cx| {
            (
                v.assist().read(cx).names_dropped,
                v.decor_layers().read(cx).name_reads,
            )
        })
    };
    wait_for(cx, "the names are read when the editor opens", |cx| {
        names(cx).1 == 1
    });
    settle(cx);
    let before = names(cx);

    let commits = e.commits_that_are_not_content();
    assert_eq!(commits, 5);
    settle(cx);
    assert_eq!(
        names(cx),
        before,
        "no writing day and no saved checkpoint is a change to the book's names"
    );

    // The book's content: read again, once for the one change.
    out(
        &e.ws,
        "book.update",
        json!({"book": e.book, "summary": "Synthetic summary"}),
    );
    wait_for(
        cx,
        "a change to the book's content reaches the editor",
        |cx| names(cx) == (before.0 + 1, before.1 + 1),
    );
    settle(cx);
    assert_eq!(names(cx), (before.0 + 1, before.1 + 1));
    // And a change written straight on the book document's holder (another
    // writer's) is content too.
    let title = e.chapters[1].0.clone();
    e.ws.library()
        .open_doc(&format!("book:{}", e.book), dr_store::OpenDoc::Existing)
        .unwrap()
        .write(dr_store::Origin::User, move |d| {
            let tree = d.get_tree("entries");
            let meta = tree
                .nodes()
                .into_iter()
                .map(|n| tree.get_meta(n).unwrap())
                .find(|m| {
                    matches!(
                        m.get("id"),
                        Some(loro::ValueOrContainer::Value(loro::LoroValue::String(s)))
                            if s.as_str() == title
                    )
                })
                .unwrap();
            meta.insert("title", "Two, renamed").unwrap();
        })
        .unwrap();
    wait_for(
        cx,
        "a change written on the holder reaches the editor",
        |cx| names(cx) == (before.0 + 2, before.1 + 2),
    );
}

#[gpui::test]
fn the_whole_book_editor_reads_its_names_again_for_content_only(cx: &mut TestAppContext) {
    let e = env();
    let from =
        dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, dr_doc::v3::novel::TPL_MANUSCRIPT);
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, &from, EditorSettings::default(), window, cx).unwrap()
    });
    let names = |cx: &mut VisualTestContext| -> Names {
        view.read_with(cx, |v, cx| {
            (
                v.assist().read(cx).names_dropped,
                v.decor_layers().read(cx).name_reads,
            )
        })
    };
    wait_for(cx, "the names are read when the editor opens", |cx| {
        names(cx).1 == 1
    });
    settle(cx);
    let before = names(cx);

    assert_eq!(e.commits_that_are_not_content(), 5);
    settle(cx);
    assert_eq!(
        names(cx),
        before,
        "no writing day and no saved checkpoint is a change to the book's names"
    );

    out(
        &e.ws,
        "entry.update",
        json!({"book": e.book, "id": e.chapters[1].0, "title": "Two, renamed"}),
    );
    wait_for(cx, "a renamed chapter reaches the editor", |cx| {
        names(cx) == (before.0 + 1, before.1 + 1)
    });
    settle(cx);
    assert_eq!(names(cx), (before.0 + 1, before.1 + 1));
}

/// The writes one working day makes, at the rates of the aging model
/// (docs/rust-rewrite/spikes/history-aging.md: three years, two devices, per
/// working day): 62 of the writing-day recorder and 16 saved checkpoints,
/// beside the book document, and 17 changes to the book's content, in it.
/// They come minutes apart, so each is let through before the next.
#[gpui::test]
fn a_day_of_writing_reads_the_names_once_for_each_change_to_the_content(cx: &mut TestAppContext) {
    let e = env();
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), e.chapters[0].1.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    let names = |cx: &mut VisualTestContext| -> Names {
        view.read_with(cx, |v, cx| {
            (
                v.assist().read(cx).names_dropped,
                v.decor_layers().read(cx).name_reads,
            )
        })
    };
    wait_for(cx, "the names are read when the editor opens", |cx| {
        names(cx).1 == 1
    });
    // The other chapter is the one written in and saved (its first point
    // may create bodies it has not written yet).
    let (other, _) = &e.chapters[1];
    out(
        &e.ws,
        "entry_snapshot.create",
        json!({"book": e.book, "entry": other}),
    );
    settle(cx);
    let before = names(cx);

    let (mut days, mut points, mut content) = (0, 0, 0);
    let commit = |cx: &mut VisualTestContext, counted: &mut usize, name: &str, input: Value| {
        let version = e.version();
        out(&e.ws, name, input);
        let content = !matches!(name, "writing_day.record" | "entry_snapshot.capture");
        assert_eq!(
            e.version() != version,
            content,
            "{name}: only the book's content commits to the book document"
        );
        *counted += 1;
        // Minutes pass before the next: whatever this one asked for is done.
        for _ in 0..4 {
            cx.run_until_parked();
            std::thread::sleep(Duration::from_millis(5));
        }
        cx.run_until_parked();
    };
    for minute in 0..62 {
        commit(
            cx,
            &mut days,
            "writing_day.record",
            json!({"book": e.book, "device": "device-000000000000000000000001",
                "day": "2026-11-12", "words": 40 * (minute + 1)}),
        );
        if minute % 4 == 1 {
            // The chapter's text moved on (another document), then its point.
            out(
                &e.ws,
                "module.set_prose",
                json!({"book": e.book, "owner": other, "module": "mod-prose",
                    "paragraphs": [{"text": format!("Synthetic text {minute}")}]}),
            );
            commit(
                cx,
                &mut points,
                "entry_snapshot.capture",
                json!({"book": e.book, "entry": other, "reason": "close"}),
            );
        }
        if minute % 4 == 3 || minute >= 60 {
            let (name, input) = match content % 3 {
                0 => (
                    "entry.update",
                    json!({"book": e.book, "id": other, "title": format!("Synthetic title {content}")}),
                ),
                1 => (
                    "fact.put",
                    json!({"book": e.book, "key": format!("Synthetic fact {content}"), "value": "Synthetic"}),
                ),
                _ => (
                    "book.update",
                    json!({"book": e.book, "summary": format!("Synthetic summary {content}")}),
                ),
            };
            commit(cx, &mut content, name, input);
            let want = (before.0 + content, before.1 + content);
            wait_for(cx, "a change to the content reaches the editor", |cx| {
                names(cx) == want
            });
        }
    }
    assert_eq!((days, points, content), (62, 16, 17));
    settle(cx);
    assert_eq!(
        names(cx),
        (before.0 + 17, before.1 + 17),
        "95 writes, 17 of them to the book's content"
    );
}
