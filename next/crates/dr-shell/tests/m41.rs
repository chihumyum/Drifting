//! M41 in the shell over a real library (《慢钟》): manuscript export opens
//! in the workspace's dialog slot (both when `成书` is enabled and when
//! `成书` is disabled), reads the project, and goes away when it closes.

use std::time::{Duration, Instant};

use dr_shell::nav::{Open, Target};
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace};
use dr_view_export::{ExportDialog, Request};
use dr_workspace::Workspace as Library;
use gpui::{Entity, TestAppContext, VisualTestContext};

const VERSION: &str = "0.2.0-dev";

fn slow_clock() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    dr_testkit::seed::write_book_v3(&lib, &dr_testkit::seed::book_to_v3(&book).unwrap()).unwrap();
    lib.close().unwrap();
    let ws = Library::open_dir(&root, VERSION).unwrap();
    (dir, ws)
}

fn setup(cx: &mut TestAppContext, library: Library) -> (Entity<Workspace>, &mut VisualTestContext) {
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
                library: Some(library),
                ..Services::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait_for(&view, cx, |ws, _| !ws.book.is_empty());
    (view, cx)
}

fn wait_for(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        if cx.update(|_, cx| done(view.read(cx), cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn dialog(ws: &Workspace) -> Option<Entity<ExportDialog>> {
    ws.dialog
        .clone()
        .and_then(|d| d.downcast::<ExportDialog>().ok())
}

#[gpui::test]
fn the_export_dialogs_open_over_the_workspace_and_close(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    let expected: Vec<String> = view.update_in(cx, |ws, window, cx| {
        let ids: Vec<String> = ws
            .book
            .v3()
            .unwrap()
            .manuscript
            .iter()
            .map(|b| b.entry.clone())
            .collect();
        let third = ids[2].clone();
        ws.open(
            Target::Entry {
                id: third.parse().unwrap(),
                module: Some("mod-prose".parse().unwrap()),
            },
            Open::KEEP,
            cx,
        );
        ws.account_open = true;
        ws.open_export(Request::Manuscript, window, cx);
        assert!(!ws.account_open, "opening export closes the account menu");
        ids
    });
    assert!(
        view.read_with(cx, |ws, _| ws.covered()),
        "the dialog covers the workspace"
    );
    wait_for(&view, cx, |ws, cx| {
        dialog(ws).is_some_and(|d| d.read(cx).manuscript().is_some_and(|m| m.outline.is_some()))
    });
    view.read_with(cx, |ws, cx| {
        let d = dialog(ws).unwrap();
        let m = d.read(cx).manuscript().unwrap();
        assert!(m.only_book_prose);
        assert_eq!(m.chapters(), expected);
    });
    // Closing drops it.
    let d = view.read_with(cx, |ws, _| dialog(ws).unwrap());
    d.update(cx, |d, cx| d.close(cx));
    cx.run_until_parked();
    assert!(view.read_with(cx, |ws, _| ws.dialog.is_none()));
}

#[gpui::test]
fn bookless_project_opens_manuscript_export_with_whole_tree_selected(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let books = lib
        .call(
            &dr_workspace::Actor::User,
            "book.list",
            serde_json::json!({}),
        )
        .unwrap()["output"]
        .clone();
    let book_id = books[0]["id"].as_str().unwrap().to_owned();
    lib.call(
        &dr_workspace::Actor::User,
        "project.update",
        serde_json::json!({"book": book_id, "has_book": false}),
    )
    .unwrap();

    let (view, cx) = setup(cx, lib);
    wait_for(&view, cx, |ws, _| {
        ws.book.v3().is_some_and(|v| v.project.book.is_none())
    });

    view.update_in(cx, |ws, window, cx| {
        let root_id = ws.book.v3().unwrap().roots[0].clone();
        ws.open(Target::Book(root_id.parse().unwrap()), Open::KEEP, cx);
        ws.open_export(Request::Manuscript, window, cx);
    });
    assert!(
        view.read_with(cx, |ws, _| ws.covered()),
        "bookless projects open manuscript export"
    );
    wait_for(&view, cx, |ws, cx| {
        dialog(ws).is_some_and(|d| d.read(cx).manuscript().is_some_and(|m| m.outline.is_some()))
    });
    view.read_with(cx, |ws, cx| {
        let d = dialog(ws).unwrap();
        let m = d.read(cx).manuscript().unwrap();
        let outline = m.outline.as_ref().unwrap();
        assert!(!outline.has_book);
        assert!(!m.only_book_prose);
        assert_eq!(m.chapters(), outline.tree_ids());
        assert!(m.can_export(cx));
    });
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// T3b: 「导出成稿」 is a row of the workspace's avatar menu, under 「导入」;
/// pressing it opens the export over the workspace.
#[gpui::test]
fn the_workspace_avatar_menu_row_opens_the_export(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    cx.simulate_resize(gpui::size(gpui::px(1280.0), gpui::px(900.0)));
    view.update(cx, |ws, cx| {
        ws.account_open = true;
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("workspace-account-import").is_some());
    let row = cx
        .debug_bounds("workspace-account-export")
        .expect("the workspace avatar menu has 「导出成稿」");
    let import = cx.debug_bounds("workspace-account-import").unwrap();
    assert!(row.origin.y > import.origin.y, "under 「导入」");
    cx.simulate_click(row.center(), gpui::Modifiers::none());
    wait_for(&view, cx, |ws, cx| {
        dialog(ws).is_some_and(|d| d.read(cx).manuscript().is_some_and(|m| m.outline.is_some()))
    });
    assert!(view.read_with(cx, |ws, _| !ws.account_open));
}

/// T3b: 全部项目's avatar menu has no 「导出成稿」, and neither a chapter's
/// nor the whole-book view's ⋯ has it.
#[gpui::test]
fn the_export_is_not_on_all_projects_nor_in_a_pages_more_menu(cx: &mut TestAppContext) {
    let (_dir, lib) = slow_clock();
    let (view, cx) = setup(cx, lib);
    let export = cx.update(|_, cx| dr_shell::t(cx, dr_i18n::keys::manuscript_export::MENU));
    // A chapter's ⋯ and the whole-book view's ⋯.
    let (chapter, root) = view.read_with(cx, |ws, _| {
        let v = ws.book.v3().unwrap();
        (v.manuscript[0].entry.clone(), v.roots[0].clone())
    });
    for target in [
        Target::Entry {
            id: chapter.parse().unwrap(),
            module: None,
        },
        Target::Book(root.parse().unwrap()),
    ] {
        let labels: Vec<String> = cx.update(|_, cx| {
            let ws = view.clone();
            let w = view.read(cx);
            let host = dr_shell::pages::PageMenuHost {
                workspace: ws.downgrade(),
                library: w.library.clone(),
                book_id: w.book_id.clone(),
                book: w.book.clone(),
            };
            dr_shell::workspace::page_actions::page_actions(&ws, &host, &target, cx)
                .into_iter()
                .flat_map(|s| s.items)
                .map(|i| i.label.to_string())
                .collect()
        });
        assert!(
            !labels.iter().any(|l| l.as_str() == export.as_ref()),
            "{target:?}'s ⋯ has no 「导出成稿」: {labels:?}"
        );
    }
    // 全部项目's avatar menu (the bookshelf draws it as `shelf-account`):
    // 「导入」 and 「导出成稿」 are the workspace's alone.
    let (_menu, mcx) = cx.cx.add_window_view(|_, _| AccountMenu("shelf-account"));
    draw(mcx);
    assert!(mcx.debug_bounds("shelf-account-export").is_none());
    assert!(mcx.debug_bounds("shelf-account-import").is_none());
    // The same menu drawn for a workspace has both.
    let (_menu, wcx) = mcx
        .cx
        .add_window_view(|_, _| AccountMenu("workspace-account"));
    draw(wcx);
    assert!(wcx.debug_bounds("workspace-account-export").is_some());
    assert!(wcx.debug_bounds("workspace-account-import").is_some());
}

/// The account menu by itself, as the bookshelf or a workspace draws it.
struct AccountMenu(&'static str);

impl gpui::Render for AccountMenu {
    fn render(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::ParentElement as _;
        gpui::div().child(dr_shell::account::menu(
            self.0,
            None,
            std::rc::Rc::new(|_, _| {}),
            window,
            cx,
        ))
    }
}
