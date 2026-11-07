//! The export dialogs on a real workspace (GPUI's test platform): the
//! manuscript's choices, the save panel and the written file; the Markdown
//! share's copy and save.

use std::time::{Duration, Instant};

use dr_export::{Format, MarkdownTarget};
use dr_i18n::{Locale, Platform};
use dr_store::Library;
use dr_view_export::{ExportDialog, Request, prefs::Prefs};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    chapters: Vec<String>,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A book with an act and three chapters, the last one discarded.
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut chapters = Vec::new();
    for (title, text) in [
        ("停摆", "钟楼停了。\n她抬头看。"),
        ("面馆", "「再来一碗。」"),
        ("废稿", "不要了。"),
    ] {
        let id = out(
            &ws,
            "chapter.create",
            json!({"book": book, "title": title, "text": text}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        chapters.push(id);
    }
    out(
        &ws,
        "chapter.update",
        json!({"book": book, "id": chapters[2], "status": "discarded"}),
    );
    out(
        &ws,
        "act.create",
        json!({"book": book, "name": "第一卷", "start_chapter": chapters[0]}),
    );
    Env {
        dir,
        ws,
        book,
        chapters,
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    request: Request,
) -> (Entity<ExportDialog>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.add_window_view(move |window, cx| {
        ExportDialog::new(
            Some(ws),
            book,
            request,
            Locale::ZhCn,
            Platform::Mac,
            window,
            cx,
        )
    })
}

fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui::test]
fn the_whole_book_exports_as_epub_and_chosen_chapters_as_word(cx: &mut TestAppContext) {
    let e = env();
    let (dialog, cx) = open(cx, &e, Request::Manuscript { chapter: None });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    dialog.read_with(cx, |d, cx| {
        let m = d.manuscript().unwrap();
        assert!(m.whole_book);
        // Every chapter but the discarded one, and the book's name.
        assert_eq!(m.chapters(), e.chapters[..2].to_vec());
        assert_eq!(m.title(cx), "慢钟");
        assert_eq!(m.format, Format::Epub);
        assert!(m.can_export(cx));
        assert!(m.outline.as_ref().unwrap().has_acts());
    });

    let epub = e.dir.path().join("慢钟.epub");
    dialog.update(cx, |d, cx| d.manuscript_mut().unwrap().export(cx));
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let epub = epub.clone();
        move |_| Some(epub)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    dialog.read_with(cx, |d, _| {
        assert_eq!(
            d.manuscript().unwrap().feedback,
            Some(dr_view_export::ManuscriptFeedback::Saved)
        )
    });
    let bytes = std::fs::read(&epub).unwrap();
    assert_eq!(&bytes[..2], b"PK", "an EPUB is a zip");

    // The choices are kept for the next export of this book.
    let kept = cx.update(|_, cx| Prefs::get(cx));
    assert_eq!(kept.books[&e.book].format, Format::Epub);

    // Only the second chapter, as Word.
    dialog.update(cx, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        m.format = Format::Docx;
        m.whole_book = false;
        m.select_all(false);
        assert!(!m.can_export(cx), "no chapter chosen");
        m.toggle(&e.chapters[1]);
        let (options, _) = m.options(cx);
        assert_eq!(options.chapters, Some(vec![e.chapters[1].clone()]));
        assert!(options.act_titles && options.chapter_titles);
    });
    let docx = e.dir.path().join("面馆.docx");
    dialog.update(cx, |d, cx| d.manuscript_mut().unwrap().export(cx));
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let docx = docx.clone();
        move |_| Some(docx)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    assert_eq!(&std::fs::read(&docx).unwrap()[..2], b"PK");
}

#[gpui::test]
fn from_a_chapter_the_choice_starts_with_it(cx: &mut TestAppContext) {
    let e = env();
    let chapter = e.chapters[1].clone();
    let (dialog, cx) = open(
        cx,
        &e,
        Request::Manuscript {
            chapter: Some(chapter.clone()),
        },
    );
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    dialog.read_with(cx, |d, _| {
        let m = d.manuscript().unwrap();
        assert!(!m.whole_book);
        assert_eq!(m.chapters(), vec![chapter.clone()]);
    });
    // A cancelled save panel writes nothing and says nothing.
    dialog.update(cx, |d, cx| d.manuscript_mut().unwrap().export(cx));
    cx.run_until_parked();
    cx.simulate_new_path_selection(|_| None);
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    dialog.read_with(cx, |d, _| {
        assert_eq!(d.manuscript().unwrap().feedback, None)
    });
}

#[gpui::test]
fn markdown_is_copied_and_saved(cx: &mut TestAppContext) {
    let e = env();
    let (dialog, cx) = open(cx, &e, Request::Markdown(MarkdownTarget::Book));
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.markdown().unwrap().doc.is_some())
    });
    let markdown = dialog.read_with(cx, |d, _| {
        d.markdown().unwrap().doc.clone().unwrap().markdown
    });
    assert!(
        markdown.contains("停摆") && markdown.contains("再来一碗"),
        "{markdown}"
    );
    dialog.update(cx, |d, cx| d.markdown_mut().unwrap().copy(cx));
    assert_eq!(
        cx.read_from_clipboard().and_then(|c| c.text()),
        Some(markdown.clone())
    );
    let path = e.dir.path().join("share.md");
    dialog.update(cx, |d, cx| d.markdown_mut().unwrap().save(cx));
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let path = path.clone();
        move |_| Some(path)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.markdown().unwrap().action.is_none())
    });
    assert_eq!(std::fs::read_to_string(&path).unwrap(), markdown);
}
