//! The manuscript export dialog on a real workspace (GPUI's test platform):
//! `只导成书正文` vs manual residence-tree selection, partial/full level ticks,
//! bookless projects opening with the whole tree ticked, `条目标题` persistence,
//! cancellation, and written EPUB/Word files.

use std::time::{Duration, Instant, SystemTime};

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
    group: String,
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
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &ws,
        "module.set_prose",
        json!({
            "book": book,
            "owner": group,
            "module": "mod-description",
            "paragraphs": [{"text": "第一卷导语：自己勾树时导出。"}]
        }),
    );
    let mut chapters = Vec::new();
    for (title, text) in [
        ("停摆", "钟楼停了。\n她抬头看。"),
        ("面馆", "「再来一碗。」"),
        ("废稿", "不要了。"),
    ] {
        let id = out(
            &ws,
            "entry.create",
            json!({
                "book": book,
                "parent": group,
                "template": "tpl-chapter",
                "title": title,
                "bodies": {"mod-prose": text}
            }),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned();
        chapters.push(id);
    }
    out(&ws, "entry.trash", json!({"book": book, "id": chapters[2]}));
    Env {
        dir,
        ws,
        book,
        group,
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
fn book_project_defaults_to_only_book_prose_and_tree_selection_cascades_levels(
    cx: &mut TestAppContext,
) {
    let e = env();
    let (dialog, cx) = open(cx, &e, Request::Manuscript);
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    dialog.read_with(cx, |d, cx| {
        let m = d.manuscript().unwrap();
        assert!(m.only_book_prose);
        assert!(m.selected.is_empty());
        assert!(m.entry_titles);
        assert_eq!(m.chapters(), e.chapters[..2].to_vec());
        assert_eq!(m.title(cx), "慢钟");
        assert_eq!(m.format, Format::Epub);
        assert!(m.can_export(cx));
        let (options, labels) = m.options(cx);
        assert_eq!(options.chapters, None);
        assert!(!options.act_titles && options.chapter_titles);
        assert_eq!(labels.untitled_chapter, "未命名条目");
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

    let kept = cx.update(|_, cx| Prefs::get(cx));
    assert_eq!(kept.books[&e.book].format, Format::Epub);
    assert!(kept.books[&e.book].entry_titles);

    // Turn off `只导成书正文`: tree starts unticked until the author ticks levels/entries.
    dialog.update(cx, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        m.format = Format::Docx;
        m.set_only_book_prose(false);
        assert!(!m.only_book_prose);
        assert!(
            !m.can_export(cx),
            "nothing ticked yet after turning off 只导成书正文"
        );

        // Clicking level `第一卷` ticks itself and both live child chapters.
        m.toggle_tree_entry(&e.group);
        let group_node = m.node(&e.group).unwrap();
        assert!(m.is_full(group_node));
        assert_eq!(
            m.chapters(),
            vec![
                e.group.clone(),
                e.chapters[0].clone(),
                e.chapters[1].clone()
            ]
        );

        // Unticking one child leaves `第一卷` ticked (partial indicator: `is_some && !is_full`).
        m.toggle_tree_entry(&e.chapters[0]);
        let group_node = m.node(&e.group).unwrap();
        assert!(!m.is_full(group_node) && m.is_some(group_node));
        assert_eq!(m.chapters(), vec![e.group.clone(), e.chapters[1].clone()]);

        // Turn off `条目标题` and verify options.
        m.entry_titles = false;
    });
    let (tree_opts, tree_labels) =
        dialog.read_with(cx, |d, cx| d.manuscript().unwrap().options(cx));
    assert_eq!(
        tree_opts.chapters,
        Some(vec![e.group.clone(), e.chapters[1].clone()])
    );
    assert!(!tree_opts.act_titles && !tree_opts.chapter_titles);
    let tree_manuscript = dr_export::v3::read_manuscript(
        &e.ws,
        &e.book,
        &tree_opts,
        &tree_labels,
        "zh-CN",
        None,
        SystemTime::UNIX_EPOCH,
    )
    .unwrap();
    let tree_json = serde_json::to_string(&tree_manuscript.sections).unwrap();
    assert!(
        tree_json.contains("第一卷导语：自己勾树时导出。"),
        "manual tree selection exports non-in_book prose modules"
    );
    assert!(tree_json.contains("「再来一碗。」"));
    assert!(!tree_json.contains("钟楼停了。"));

    let docx = e.dir.path().join("第一卷-选导出.docx");
    dialog.update(cx, |d, cx| d.manuscript_mut().unwrap().export(cx));
    cx.run_until_parked();
    cx.simulate_new_path_selection({
        let docx = docx.clone();
        move |_| Some(docx)
    });
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    let docx_bytes = std::fs::read(&docx).unwrap();
    assert_eq!(&docx_bytes[..2], b"PK");

    let kept_after = cx.update(|_, cx| Prefs::get(cx));
    assert_eq!(kept_after.books[&e.book].format, Format::Docx);
    assert!(!kept_after.books[&e.book].entry_titles);
}

#[gpui::test]
fn cancelled_save_panel_writes_nothing_and_leaves_feedback_empty(cx: &mut TestAppContext) {
    let e = env();
    let (dialog, cx) = open(cx, &e, Request::Manuscript);
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
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
fn export_dialog_reads_book_from_root_and_bookless_project_starts_with_whole_tree_ticked(
    cx: &mut TestAppContext,
) {
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
            "bodies": {"mod-description": "番外说明只在勾树时导出"}
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

    // With `成书` enabled, `只导成书正文` defaults on and reads the single book sequence from the root.
    let (initial_dialog, cx_initial) = open(cx, &e, Request::Manuscript);
    wait_for(cx_initial, |cx| {
        initial_dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    initial_dialog.read_with(cx_initial, |d, cx| {
        let m = d.manuscript().unwrap();
        assert!(m.outline.as_ref().unwrap().has_book);
        assert!(m.only_book_prose);
        assert!(m.can_export(cx));
        let mut want = e.chapters[..2].to_vec();
        want.push(epilogue.clone());
        assert_eq!(m.chapters(), want);
    });

    // When `成书` is turned off (`has_book: false`), there is no `只导成书正文`
    // switch and the entire residence tree starts ticked and ready to export.
    out(
        &e.ws,
        "project.update",
        json!({"book": e.book, "has_book": false}),
    );
    let (bookless_dialog, cx_bookless) = open(cx, &e, Request::Manuscript);
    wait_for(cx_bookless, |cx| {
        bookless_dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    let (bookless_opts, bookless_labels) = bookless_dialog.update(cx_bookless, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        let outline = m.outline.as_ref().unwrap();
        assert!(!outline.has_book);
        assert!(!m.only_book_prose);
        assert_eq!(m.chapters(), outline.tree_ids());
        assert!(m.can_export(cx));
        let (opts, labels) = m.options(cx);
        assert_eq!(opts.chapters, Some(outline.tree_ids()));
        m.export(cx);
        (opts, labels)
    });
    let bookless_manuscript = dr_export::v3::read_manuscript(
        &e.ws,
        &e.book,
        &bookless_opts,
        &bookless_labels,
        "zh-CN",
        None,
        SystemTime::UNIX_EPOCH,
    )
    .unwrap();
    let bookless_json = serde_json::to_string(&bookless_manuscript.sections).unwrap();
    assert!(bookless_json.contains("番外说明只在勾树时导出"));
    cx_bookless.run_until_parked();
    assert!(cx_bookless.did_prompt_for_new_path());
    let epub = e.dir.path().join("无成书整树导出.epub");
    cx_bookless.simulate_new_path_selection({
        let epub = epub.clone();
        move |_| Some(epub)
    });
    wait_for(cx_bookless, |cx| {
        bookless_dialog.read_with(cx, |d, _| !d.manuscript().unwrap().is_busy())
    });
    assert_eq!(
        bookless_dialog.read_with(cx_bookless, |d, _| d.manuscript().unwrap().feedback.clone()),
        Some(dr_view_export::ManuscriptFeedback::Saved)
    );
    let epub_bytes = std::fs::read(&epub).unwrap();
    assert_eq!(&epub_bytes[..2], b"PK");

    // Unticking everything in a bookless project disables export.
    bookless_dialog.update(cx_bookless, |d, cx| {
        let m = d.manuscript_mut().unwrap();
        m.select_all(false);
        assert!(m.chapters().is_empty());
        assert!(!m.can_export(cx));
        m.export(cx);
    });
    cx_bookless.run_until_parked();
    assert!(!cx_bookless.did_prompt_for_new_path());
}

/// A debug selector made at run time (they are `'static`).
fn selector(name: String) -> &'static str {
    Box::leak(name.into_boxed_str())
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// With 「只导成书正文」 on the tree does not take a click; a book with no
/// text yet says so under the switch, which stays on, and nothing exports
/// (作者 2026-11-16 九丙).
#[gpui::test]
fn the_book_text_switch_holds_the_tree_and_an_empty_book_says_so(cx: &mut TestAppContext) {
    let e = env();
    let (dialog, cx) = open(cx, &e, Request::Manuscript);
    cx.simulate_resize(gpui::size(gpui::px(900.0), gpui::px(1100.0)));
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    draw(cx);
    let row = cx
        .debug_bounds(selector(format!("export-row-{}", e.group)))
        .expect("the level's row is drawn");
    cx.simulate_click(row.center(), gpui::Modifiers::none());
    draw(cx);
    dialog.update(cx, |d, _| {
        let m = d.manuscript_mut().unwrap();
        assert!(m.only_book_prose);
        assert!(m.selected.is_empty(), "the tree did not take the click");
        m.toggle_tree_entry(&e.chapters[0]);
        assert!(m.selected.is_empty());
        assert!(!m.book_is_empty());
    });
    assert!(cx.debug_bounds("export-book-empty").is_none());
}

#[gpui::test]
fn an_empty_book_says_so_under_the_switch_and_exports_nothing(cx: &mut TestAppContext) {
    let e = env();
    for chapter in &e.chapters[..2] {
        out(&e.ws, "entry.trash", json!({"book": e.book, "id": chapter}));
    }
    let (dialog, cx) = open(cx, &e, Request::Manuscript);
    wait_for(cx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    draw(cx);
    dialog.read_with(cx, |d, cx| {
        let m = d.manuscript().unwrap();
        assert!(m.outline.as_ref().unwrap().has_book);
        assert!(m.only_book_prose, "the switch stays on");
        assert!(m.book_is_empty());
        assert!(!m.can_export(cx));
    });
    assert!(cx.debug_bounds("export-book-empty").is_some());
    // Picking by hand: no word about the book.
    dialog.update(cx, |d, _| {
        d.manuscript_mut().unwrap().set_only_book_prose(false)
    });
    draw(cx);
    assert!(cx.debug_bounds("export-book-empty").is_none());
}

/// The scope tree lists the entries hung on one after the ones living under
/// it, as the left sidebar's tree does: a dotted rule in their indent, their
/// own tick for that place, and a level's tick takes them with it (作者
/// 2026-11-16 十乙).
#[gpui::test]
fn hung_entries_are_rows_of_their_own_after_the_ones_living_there(cx: &mut TestAppContext) {
    let e = env();
    let storylines = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-storylines");
    let line = out(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "parent": storylines, "template": "tpl-storyline", "title": "主线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &e.ws,
        "membership.add",
        json!({"book": e.book, "host": line, "member": e.chapters[0]}),
    );
    let pick = (line.clone(), e.chapters[0].clone());
    let (dialog, vcx) = open(cx, &e, Request::Manuscript);
    vcx.simulate_resize(gpui::size(gpui::px(900.0), gpui::px(1400.0)));
    wait_for(vcx, |cx| {
        dialog.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    dialog.update(vcx, |d, _| {
        let m = d.manuscript_mut().unwrap();
        assert_eq!(m.outline.as_ref().unwrap().hung_rows(), vec![pick.clone()]);
        m.set_only_book_prose(false);
        // The hung row alone: this place of the chapter only.
        m.toggle_hung(&pick.0, &pick.1);
        assert_eq!(m.hung(), vec![pick.clone()]);
        assert!(m.chapters().is_empty());
        let host = m.node(&line).unwrap();
        assert!(m.is_some(host) && !m.is_full(host));
    });
    dialog.read_with(vcx, |d, cx| assert!(d.manuscript().unwrap().can_export(cx)));
    draw(vcx);
    assert!(
        vcx.debug_bounds(selector(format!("export-hung-row-{}-{}", pick.0, pick.1)))
            .is_some()
    );
    assert!(
        vcx.debug_bounds(selector(format!("export-hung-rule-{}-{}", pick.0, pick.1)))
            .is_some(),
        "a dotted rule in the hung row's indent"
    );
    dialog.update(vcx, |d, _| {
        let m = d.manuscript_mut().unwrap();
        // The host's tick takes what is hung on it; again, it lets all go.
        m.toggle_tree_entry(&line);
        let host = m.node(&line).unwrap();
        assert!(m.is_full(host));
        assert_eq!(m.chapters(), vec![line.clone()]);
        assert_eq!(m.hung(), vec![pick.clone()]);
        m.toggle_tree_entry(&line);
        assert!(m.chapters().is_empty() && m.hung().is_empty());
        // Folded, the host hides its hung rows too.
        m.toggle_collapse(&line);
    });
    draw(vcx);
    assert!(
        vcx.debug_bounds(selector(format!("export-hung-row-{}-{}", pick.0, pick.1)))
            .is_none()
    );

    // A project without a book opens with all of it ticked, hung rows too.
    out(
        &e.ws,
        "project.update",
        json!({"book": e.book, "has_book": false}),
    );
    let (bookless, cx2) = open(cx, &e, Request::Manuscript);
    wait_for(cx2, |cx| {
        bookless.read_with(cx, |d, _| d.manuscript().unwrap().outline.is_some())
    });
    bookless.read_with(cx2, |d, cx| {
        let m = d.manuscript().unwrap();
        assert_eq!(m.hung(), vec![pick.clone()]);
        assert_eq!(m.options(cx).0.hung, vec![pick.clone()]);
    });
}
