//! The export dialogs on a real workspace (GPUI's test platform): the
//! manuscript's choices, the save panel, cancellation and the written file.

use std::time::{Duration, Instant};

use dr_export::Format;
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

/// A canonical manuscript group and three entries, the last one trashed.
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "project.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let group = dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-group", "第一卷", None)
        ["id"]
        .clone();
    let mut chapters = Vec::new();
    for (title, text) in [
        ("停摆", "钟楼停了。\n她抬头看。"),
        ("面馆", "「再来一碗。」"),
        ("废稿", "不要了。"),
    ] {
        let id = out(
            &ws,
            "entry.create", json!({"book": book, "parent": group, "template": "tpl-chapter", "title": title, "bodies": {"mod-prose": text}}),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        chapters.push(id);
    }
    out(&ws, "entry.trash", json!({"book":book,"id":chapters[2]}));
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
fn v3_export_selects_manuscript_entries_and_saves_without_builtin_acts(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path().join("library"), library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&lib).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let entries = dr_export::v3::outline(&ws, &book).unwrap().entries;
    let chosen = entries[0].id.clone();
    let e = Env {
        dir,
        ws,
        book,
        chapters: entries.into_iter().map(|e| e.id).collect(),
    };
    let (dialog, cx) = open(
        cx,
        &e,
        Request::Manuscript {
            chapter: Some(chosen.clone()),
        },
    );
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    dialog.read_with(cx, |d, cx| {
        let m = d.manuscript().unwrap();
        assert!(m.v3);
        assert!(!m.whole_book);
        assert_eq!(m.chapters(), [chosen]);
        assert!(!m.outline.as_ref().unwrap().has_acts());
        let (options, labels) = m.options(cx);
        assert!(!options.act_titles);
        assert_eq!(labels.untitled_chapter, "未命名条目");
    });
    let path = e.dir.path().join("v3-manuscript.docx");
    dialog.update(cx, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        m.format = Format::Docx;
        m.export(cx);
    });
    cx.run_until_parked();
    assert!(cx.did_prompt_for_new_path());
    cx.simulate_new_path_selection({
        let path = path.clone();
        move |_| Some(path)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    assert_eq!(
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().feedback.clone()),
        Some(dr_view_export::ManuscriptFeedback::Saved)
    );
    assert_eq!(&std::fs::read(path).unwrap()[..2], b"PK");
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
        // Every manuscript entry except the trashed one, and the book name.
        assert_eq!(m.chapters(), e.chapters[..2].to_vec());
        assert_eq!(m.title(cx), "慢钟");
        assert_eq!(m.format, Format::Epub);
        assert!(m.can_export(cx));
        assert!(!m.outline.as_ref().unwrap().has_acts());
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
        assert!(!options.act_titles && options.chapter_titles);
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
fn multiple_manuscript_parts_let_the_author_choose_which_to_export(cx: &mut TestAppContext) {
    use std::time::SystemTime;

    let e = env();
    let extra_box = out(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "template": "tpl-group", "level": true, "title": "外集"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let side_root = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "parent": extra_box,
            "template": "tpl-manuscript",
            "level": true,
            "title": "番外",
            "bodies": {"mod-description": "番外说明不导出"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let epilogue = out(
        &e.ws,
        "entry.create",
        json!({
            "book": e.book,
            "parent": side_root,
            "template": "tpl-chapter",
            "title": "后记",
            "bodies": {"mod-prose": "灯火渐熄。"}
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Opened from an entry in the second manuscript part: pre-selects that part.
    let (from_side, cx_side) = open(
        cx,
        &e,
        Request::Manuscript {
            chapter: Some(epilogue.clone()),
        },
    );
    wait_for(cx_side, |cx| {
        from_side.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    from_side.read_with(cx_side, |d, cx| {
        let m = d.manuscript().unwrap();
        assert_eq!(m.manuscripts.len(), 2);
        assert_eq!(m.part_labels(), ["书稿", "外集 / 番外"]);
        assert_eq!(m.manuscript, 1);
        assert!(!m.whole_book);
        assert_eq!(m.chapters(), vec![epilogue.clone()]);
        assert_eq!(
            m.options(cx).0.manuscript.as_deref(),
            Some(side_root.as_str())
        );
    });

    // Opened for the book: starts on the first manuscript part, then switches to
    // the second and writes only that manuscript's EPUB.
    let (dialog, cx) = open(cx, &e, Request::Manuscript { chapter: None });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    let (chosen_opts, chosen_labels) = dialog.update(cx, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        assert_eq!(m.manuscripts.len(), 2);
        assert_eq!(m.manuscript, 0);
        assert_eq!(m.chapters(), e.chapters[..2].to_vec());
        m.select_manuscript(1);
        assert_eq!(m.manuscript, 1);
        assert_eq!(m.chapters(), vec![epilogue.clone()]);
        let (opts, labels) = m.options(cx);
        assert_eq!(opts.manuscript.as_deref(), Some(side_root.as_str()));
        m.export(cx);
        (opts, labels)
    });
    let read_back = dr_export::v3::read_manuscript(
        &e.ws,
        &e.book,
        &chosen_opts,
        &chosen_labels,
        "zh-CN",
        None,
        SystemTime::UNIX_EPOCH,
    )
    .unwrap();
    assert_eq!(read_back.sections.len(), 1);
    match &read_back.sections[0] {
        dr_export::Section::Chapter { title, blocks, .. } => {
            assert_eq!(title, "后记");
            assert_eq!(blocks.len(), 1);
        }
        other => panic!("unexpected section: {other:?}"),
    }

    cx.run_until_parked();
    let epub = e.dir.path().join("番外.epub");
    cx.simulate_new_path_selection({
        let epub = epub.clone();
        move |_| Some(epub)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    assert_eq!(
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().feedback.clone()),
        Some(dr_view_export::ManuscriptFeedback::Saved)
    );
    let bytes = std::fs::read(&epub).unwrap();
    assert_eq!(&bytes[..2], b"PK");
}
