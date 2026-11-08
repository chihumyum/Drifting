//! 「导入文件」 in the shell over a real library (GPUI's test platform): the
//! account menu's action opens it over the open book; files are read as they
//! are added (only the kinds it reads, in natural name order), their titles
//! can be changed, and 「开始导入」 writes chapters into the chosen storyline;
//! a taken element name fails alone.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_view_transfer::documents::{DocumentsDialog, Kind, Status};
use dr_workspace::{Actor, Workspace as Lib, WorkspaceOptions, library_options};
use gpui::{Entity, TestAppContext, VisualTestContext};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn out(ws: &Lib, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn setup(cx: &mut TestAppContext, lib: Lib) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: VERSION,
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_transfer::init(cx);
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| cx.read(|cx| !view.read(cx).book.is_empty()));
    (view, cx)
}

fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn dialog(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Option<Entity<DocumentsDialog>> {
    cx.read(|cx| {
        view.read(cx)
            .dialog
            .clone()
            .and_then(|d| d.downcast::<DocumentsDialog>().ok())
    })
}

#[gpui::test]
fn files_become_chapters_of_the_chosen_storyline(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Lib::open(
        Library::open(dir.path().join("library"), library_options(VERSION)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap();
    let book = out(&lib, "book.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &lib,
        "storyline.create",
        json!({"book": book, "name": "主线"}),
    );
    let second = out(
        &lib,
        "storyline.create",
        json!({"book": book, "name": "支线"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(&lib, "chapter.create", json!({"book": book, "title": "序"}));
    let files = dir.path().join("drafts");
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("10 尾声.md"), "# 尾声\n\n钟又走了。").unwrap();
    std::fs::write(files.join("2 雨夜.txt"), "雨夜。\n\n她没回头。").unwrap();
    std::fs::write(files.join("notes.pdf"), "not read").unwrap();

    let (view, cx) = setup(cx, lib.clone());
    // The account menu's row.
    cx.update(|window, cx| {
        window.dispatch_action(Box::new(dr_shell::actions::ImportDocuments), cx)
    });
    wait(cx, |cx| dialog(&view, cx).is_some());
    let d = dialog(&view, cx).unwrap();

    // A folder's files: the PDF is left out, `2` comes before `10`.
    let paths: Vec<_> = std::fs::read_dir(&files)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    cx.update(|window, cx| d.update(cx, |d, cx| d.add(paths, window, cx)));
    wait(cx, |cx| d.read_with(cx, |d, _| d.ready() == 2));
    let titles = cx.read(|cx| {
        d.read(cx)
            .items
            .iter()
            .map(|i| (i.filename.clone(), i.title(cx)))
            .collect::<Vec<_>>()
    });
    assert_eq!(
        titles,
        [
            ("2 雨夜.txt".to_owned(), "雨夜".to_owned()),
            ("10 尾声.md".to_owned(), "尾声".to_owned())
        ]
    );
    // Into 支线.
    d.update(cx, |d, cx| {
        assert_eq!(d.kind, Kind::Chapter);
        d.storyline = d.storylines.iter().position(|s| s.0 == second).unwrap();
        d.start(cx);
    });
    wait(cx, |cx| d.read_with(cx, |d, _| d.summary.is_some()));
    assert_eq!(d.read_with(cx, |d, _| d.summary), Some((2, 0)));
    let chapters = out(&lib, "chapter.list", json!({"book": book}));
    let got: Vec<(Value, Value)> = chapters
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["title"].clone(), c["storylines"].clone()))
        .collect();
    assert_eq!(
        got,
        [
            (json!("序"), json!([])),
            (json!("雨夜"), json!([second.clone()])),
            (json!("尾声"), json!([second.clone()]))
        ]
    );

    // Elements: a taken name fails alone.
    out(
        &lib,
        "element.create",
        json!({"book": book, "name": "尾声"}),
    );
    d.update(cx, |d, cx| {
        d.clear(cx);
        d.kind = Kind::Element;
    });
    let again: Vec<_> = std::fs::read_dir(&files)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    cx.update(|window, cx| d.update(cx, |d, cx| d.add(again, window, cx)));
    wait(cx, |cx| d.read_with(cx, |d, _| d.ready() == 2));
    d.update(cx, |d, cx| d.start(cx));
    wait(cx, |cx| d.read_with(cx, |d, _| d.summary.is_some()));
    assert_eq!(d.read_with(cx, |d, _| d.summary), Some((1, 1)));
    let failed = d.read_with(cx, |d, _| {
        d.items
            .iter()
            .filter(|i| matches!(i.status, Status::Error(_)))
            .map(|i| i.filename.clone())
            .collect::<Vec<_>>()
    });
    assert_eq!(failed, ["10 尾声.md"]);

    // 「关闭」.
    cx.cx.update(|cx| d.update(cx, |d, cx| d.close(cx)));
    cx.run_until_parked();
    assert!(dialog(&view, cx).is_none());
}

#[test]
fn warnings_are_in_the_interface_language() {
    use dr_export::import::ImportWarning::{ImagesDropped, NotUtf8};
    use dr_i18n::{I18n, Locale, Platform};
    use dr_view_transfer::documents::warning;
    let zh = I18n::new(Locale::ZhCn, Platform::Mac);
    assert_eq!(warning(&zh, &ImagesDropped(2)), "2 张图片没有导入");
    assert_eq!(warning(&zh, &NotUtf8), "不是 UTF-8 文本，有些字符被替换了");
    let en = I18n::new(Locale::En, Platform::Mac);
    assert_eq!(warning(&en, &ImagesDropped(1)), "1 image wasn't imported");
    assert_eq!(warning(&en, &ImagesDropped(3)), "3 images weren't imported");
    let ko = I18n::new(Locale::Ko, Platform::Mac);
    assert_eq!(
        warning(&ko, &ImagesDropped(1)),
        "이미지 1개는 가져오지 않았습니다"
    );
}
