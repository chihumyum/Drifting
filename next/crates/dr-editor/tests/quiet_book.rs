//! The editors follow the book's content, not every commit to its document.
//! The writing-day recorder commits to the book document once a minute and
//! every saved entry checkpoint commits once; neither changes a name, a link
//! target or a chapter, so neither makes an open editor read its names again.

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

    /// Commits to the book document that change none of its content: this
    /// device's writing day (twice), another device's arriving by sync, and
    /// a checkpoint of each chapter. Every one of them moves the document's
    /// version on.
    fn commits_that_are_not_content(&self) -> usize {
        let doc = format!("book:{}", self.book);
        let mut commits = 0;
        let mut moved = |what: &str, before: String| {
            assert_ne!(self.version(), before, "{what} is a commit to the book");
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
        let other = self.ws.library().load_copy(&doc).unwrap();
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
                    &doc,
                    Some(("book", self.book.as_str())),
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
    // And a change that carries a writing day with the content is content.
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
            d.get_map("writing_days")
                .insert("device-000000000000000000000001|2026-11-12", 130)
                .unwrap();
        })
        .unwrap();
    wait_for(cx, "content with a writing day reaches the editor", |cx| {
        names(cx) == (before.0 + 2, before.1 + 2)
    });
}

#[gpui::test]
fn the_whole_book_editor_reads_its_names_again_for_content_only(cx: &mut TestAppContext) {
    let e = env();
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, EditorSettings::default(), window, cx).unwrap()
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
