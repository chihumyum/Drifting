//! 「导入文件」 in the shell over a real library (GPUI's test platform): the
//! account menu's action opens it over the open book; target levels are listed
//! as tree paths for every live entry with its level switch on; files are read
//! as they are added (only the kinds it reads, in natural name order), their
//! titles can be changed, and 「开始导入」 writes entries into the chosen level
//! using its resolved default template; a taken name fails alone.

use std::time::{Duration, Instant};

use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_store::Library;
use dr_view_transfer::documents::{DocumentsDialog, Status};
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
    let book = out(&lib, "project.create", json!({"name": "慢钟"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    dr_testkit::seed::acceptance::novel_entry(&lib, &book, "tpl-storyline", "主线", None);
    let second =
        dr_testkit::seed::acceptance::novel_entry(&lib, &book, "tpl-storyline", "支线", None)["id"]
            .as_str()
            .unwrap()
            .to_owned();
    out(
        &lib,
        "entry.create",
        json!({"book": book, "parent": dr_testkit::seed::acceptance::novel_root(&lib, &book, "tpl-manuscript"), "template": "tpl-chapter", "title": "序"}),
    );
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
    // Every live entry with its level switch on, in tree order as paths;
    // `序` (`level == false`) is not listed.
    let paths_in_tree = d.read_with(cx, |d, _| {
        d.levels.iter().map(|l| l.path.clone()).collect::<Vec<_>>()
    });
    assert_eq!(
        paths_in_tree,
        [
            "书稿",
            "构想",
            "要素",
            "要素 / 人物",
            "要素 / 地点",
            "要素 / 道具",
            "要素 / 组织",
            "故事线",
            "故事线 / 主线",
            "故事线 / 支线",
            "幕",
        ]
        .into_iter()
        .filter(|p| *p != "幕" || paths_in_tree.iter().any(|x| x == "幕"))
        .collect::<Vec<_>>()
    );
    assert!(!paths_in_tree.iter().any(|p| p.ends_with("序")));

    // Into 故事线 / 支线.
    d.update(cx, |d, cx| {
        assert_eq!(d.level, 0);
        let idx = d.levels.iter().position(|s| s.id == second).unwrap();
        assert_eq!(d.levels[idx].path, "故事线 / 支线");
        d.level = idx;
        d.start(cx);
    });
    wait(cx, |cx| d.read_with(cx, |d, _| d.summary.is_some()));
    assert_eq!(d.read_with(cx, |d, _| d.summary), Some((2, 0)));
    let chapters = dr_testkit::seed::acceptance::entries_by_template(&lib, &book, "tpl-chapter");
    assert_eq!(
        chapters
            .iter()
            .map(|e| e["title"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["序", "雨夜", "尾声"]
    );
    let memberships = out(&lib, "membership.list", json!({"book":book}));
    for entry in &chapters[1..] {
        assert!(
            memberships
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["host"] == second && m["member"] == entry["id"])
        );
    }

    // Into 要素 / 人物: a taken name fails alone.
    dr_testkit::seed::acceptance::novel_entry(&lib, &book, "tpl-character", "尾声", None);
    d.update(cx, |d, cx| {
        d.clear(cx);
        d.level = d
            .levels
            .iter()
            .position(|l| l.path == "要素 / 人物")
            .unwrap();
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

#[gpui::test]
fn levels_follow_the_level_switch_and_nested_tree_paths(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = Lib::open(
        Library::open(dir.path().join("library"), library_options(VERSION)).unwrap(),
        WorkspaceOptions::default(),
    )
    .unwrap();
    let book = out(&lib, "project.create", json!({"name": "树径"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let manuscript = dr_testkit::seed::acceptance::novel_root(&lib, &book, "tpl-manuscript");
    let volume = out(
        &lib,
        "entry.create",
        json!({
            "book": book,
            "parent": manuscript,
            "template": "tpl-group",
            "level": true,
            "title": "第一卷"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let prologue = out(
        &lib,
        "entry.create",
        json!({
            "book": book,
            "parent": manuscript,
            "template": "tpl-chapter",
            "title": "楔子"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &lib,
        "entry.set_level",
        json!({"book": book, "id": prologue, "level": true}),
    );
    let all = out(&lib, "entry.list", json!({"book": book, "all": true}));
    let org = all
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["title"] == "组织")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out(
        &lib,
        "entry.set_level",
        json!({"book": book, "id": org, "level": false}),
    );

    let draft = dir.path().join("01 桥雾.md");
    std::fs::write(&draft, "# 桥雾\n\n雾从河面升起。").unwrap();

    let (view, cx) = setup(cx, lib.clone());
    cx.update(|window, cx| {
        window.dispatch_action(Box::new(dr_shell::actions::ImportDocuments), cx)
    });
    wait(cx, |cx| dialog(&view, cx).is_some());
    let d = dialog(&view, cx).unwrap();

    let paths = d.read_with(cx, |d, _| {
        d.levels.iter().map(|l| l.path.clone()).collect::<Vec<_>>()
    });
    assert!(paths.contains(&"书稿 / 第一卷".to_owned()), "{paths:?}");
    assert!(paths.contains(&"书稿 / 楔子".to_owned()), "{paths:?}");
    assert!(!paths.iter().any(|p| p == "要素 / 组织"), "{paths:?}");

    cx.update(|window, cx| d.update(cx, |d, cx| d.add(vec![draft], window, cx)));
    wait(cx, |cx| d.read_with(cx, |d, _| d.ready() == 1));
    d.update(cx, |d, cx| {
        d.level = d.levels.iter().position(|l| l.id == volume).unwrap();
        d.start(cx);
    });
    wait(cx, |cx| d.read_with(cx, |d, _| d.summary.is_some()));
    assert_eq!(d.read_with(cx, |d, _| d.summary), Some((1, 0)));

    let children = out(&lib, "entry.list", json!({"book": book, "parent": volume}));
    let arr = children.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["title"], "桥雾");
    assert_eq!(arr[0]["template"], "tpl-chapter");
}

#[test]
fn import_dialog_copy_names_target_and_files_across_all_locales() {
    use dr_i18n::{I18n, Locale, Platform, keys};
    let zh = I18n::new(Locale::ZhCn, Platform::Mac);
    assert_eq!(zh.t(keys::v3_transfer::TARGET_TITLE), "目标");
    assert_eq!(zh.t(keys::v3_transfer::FILES_TITLE), "文件");

    for locale in Locale::ALL {
        let i18n = I18n::new(locale, Platform::Mac);
        assert!(!i18n.t(keys::v3_transfer::TARGET_TITLE).trim().is_empty());
        assert!(!i18n.t(keys::v3_transfer::FILES_TITLE).trim().is_empty());
    }
}
