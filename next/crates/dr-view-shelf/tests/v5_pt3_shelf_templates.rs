//! PT3 (`pt3-template-ui`) shelf tests (`docs/rust-rewrite/handoff/v5-tracks.md`
//! PT3; `docs/rust-rewrite/project-templates.md` §8, §12, §15 PT3):
//!
//! - Empty vs non-empty 「我的模板」 rail section, most-recently-updated ordering,
//!   inert row click, hover card (name, author without 「改自」, description,
//!   edit / export / delete), delete confirmation cancel vs confirm, and
//!   「导入模板」 rail cell action.
//! - Importing a `.driftingtemplate` file adds to 「我的模板」 without creating
//!   any project.
//! - 「新建项目」 template-picker dialog when 0 custom templates exist (still
//!   opens with built-in 「写书」 alone) and with custom templates (default
//!   「写书」, collapsible 「我的模板」, live right-pane preview, no 「改自」).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_shelf::{ExportTemplate, ImportTemplate, Shelf, ShelfDialog, TemplatePick};
use dr_workspace::{
    Actor, Workspace as Library,
    commands::v3::{
        project_template::{
            ProjectTemplateExport, ProjectTemplateExportIn, ProjectTemplateGet,
            ProjectTemplateIdIn, ProjectTemplateImport, ProjectTemplateImportIn,
            ProjectTemplateSave, ProjectTemplateSaveIn, ProjectTemplateUpdate,
            ProjectTemplateUpdateIn,
        },
        types::TemplateAgentConfig,
    },
};
use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext, px, size};

const VERSION: &str = "0.2.0-dev";

fn library() -> (tempfile::TempDir, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let lib = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let book = dr_testkit::samples::slow_clock().unwrap();
    let v3 = dr_testkit::seed::book_to_v3(&book).unwrap();
    let book_id = v3.book_id().to_string();
    dr_testkit::seed::write_book_v3(&lib, &v3).unwrap();
    lib.rebuild_stale_indexes().unwrap();
    lib.close().unwrap();
    (dir, Library::open_dir(&root, VERSION).unwrap(), book_id)
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
        Settings::update(cx, |s| {
            s.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        });
        dr_view_shelf::init(cx);
    });
    let (view, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(900.0)));
    vcx.update(|window, _| window.activate_window());
    vcx.run_until_parked();
    (view, vcx)
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        cx.executor().advance_clock(Duration::from_millis(30));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "shelf PT3 timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

// Project-template updates are stored in Unix seconds. Exercise a strictly
// newer timestamp instead of depending on the ID tie-breaker for equal ones.
fn next_template_second() {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    std::thread::sleep(Duration::from_secs(1) - Duration::from_nanos(now.subsec_nanos().into()));
}

fn shelf_of(view: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<Shelf> {
    view.read_with(cx, |ws, _| ws.shelf.clone())
        .expect("shelf mounted")
        .view
        .downcast::<Shelf>()
        .expect("Shelf entity")
}

#[gpui::test]
fn zero_templates_hides_rail_section_and_new_project_dialog_still_opens_with_builtin_only(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, _book_id) = library();
    let (view, vcx) = setup(cx, lib.clone());
    let shelf = shelf_of(&view, vcx);

    wait(vcx, "initial shelf loaded", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data
                .as_ref()
                .is_some_and(|d| d.books.len() == 1 && d.templates.is_empty())
        })
    });

    // 1. With 0 saved templates, 「我的模板」 is completely absent from the left rail,
    //    while 「导入模板」 is present.
    assert!(vcx.debug_bounds("shelf-my-templates-section").is_none());
    assert!(vcx.debug_bounds("shelf-my-templates-header").is_none());
    assert!(vcx.debug_bounds("shelf-import-template").is_some());

    // 2. Clicking 「新建项目」 with 0 saved templates STILL opens the template-picker dialog,
    //    with only built-in 「写书」 on the left and its full preview on the right!
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    wait(vcx, "new project dialog drawn", |vcx| {
        vcx.debug_bounds("shelf-new-left-pane").is_some()
            && vcx.debug_bounds("shelf-new-preview-tree").is_some()
    });
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.dialog()),
        Some(ShelfDialog::Create)
    );
    assert!(vcx.debug_bounds("shelf-new-pick-builtin").is_some());
    assert!(
        vcx.debug_bounds("shelf-new-my-templates-toggle").is_none(),
        "no My templates group when library has 0 custom templates"
    );
    assert!(vcx.debug_bounds("shelf-new-preview-author").is_none());
    assert!(vcx.debug_bounds("shelf-new-preview-agent").is_some());
    assert!(vcx.debug_bounds("shelf-new-preview-rail").is_some());
    assert!(vcx.debug_bounds("shelf-new-preview-views").is_some());
    assert!(vcx.debug_bounds("shelf-new-preview-book").is_some());

    let cancel = vcx.debug_bounds("shelf-new-cancel").unwrap();
    vcx.simulate_click(cancel.center(), Modifiers::none());
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);

    // 3. The dialog holds the keyboard: Esc closes it and nothing else, ↩
    //    creates (as ⌘↵ does) and opens the new project.
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    wait(vcx, "new project dialog drawn again", |vcx| {
        vcx.debug_bounds("shelf-new-left-pane").is_some()
    });
    let modal = shelf.read_with(vcx, |s, _| s.new_project_dialog().unwrap());
    assert!(
        vcx.update(|window, cx| modal.focus_handle(cx).is_focused(window)),
        "the new-project dialog holds the keyboard"
    );
    vcx.simulate_keystrokes("escape");
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    assert!(
        view.read_with(vcx, |ws, _| ws.shelf_open),
        "Esc closes the dialog alone"
    );
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    wait(vcx, "new project dialog drawn a third time", |vcx| {
        vcx.debug_bounds("shelf-new-left-pane").is_some()
    });
    vcx.simulate_keystrokes("enter");
    wait(vcx, "↩ created the project and opened it", |vcx| {
        view.read_with(vcx, |ws, _| !ws.shelf_open && ws.book.name == "未命名")
    });
    lib.close();
}

#[gpui::test]
fn new_project_preview_shows_the_agent_name_and_notes_only(cx: &mut TestAppContext) {
    let (_dir, lib, book_id) = library();
    let save = |name: &str, agent: TemplateAgentConfig| {
        lib.run::<ProjectTemplateSave>(
            &Actor::User,
            ProjectTemplateSaveIn {
                book: book_id.clone(),
                name: Some(name.into()),
                description: None,
                locale: None,
                credit: None,
                agent: Some(Some(agent)),
                exclude_skeleton: Vec::new(),
                sample_entries: Vec::new(),
                view_pins: Vec::new(),
                replace: None,
            },
        )
        .unwrap()
        .output
        .id
    };
    let full = save(
        "三栏都填",
        TemplateAgentConfig {
            name: "设定助手".into(),
            description: "一部设定集。".into(),
            instructions: "先读梗概再改正文。".into(),
        },
    );
    let described = save(
        "只有说明",
        TemplateAgentConfig {
            name: String::new(),
            description: "只写了说明。".into(),
            instructions: String::new(),
        },
    );
    let (view, vcx) = setup(cx, lib.clone());
    let shelf = shelf_of(&view, vcx);
    wait(vcx, "two templates listed", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data.as_ref().is_some_and(|d| d.templates.len() == 2)
        })
    });
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    let modal = shelf.read_with(vcx, |s, _| s.new_project_dialog().unwrap());

    // 「我的模板」's fold arrow comes after its words, as the prototype draws it.
    wait(vcx, "fold header drawn", |vcx| {
        vcx.debug_bounds("shelf-new-my-templates-arrow").is_some()
    });
    let label = vcx.debug_bounds("shelf-new-my-templates-label").unwrap();
    let arrow = vcx.debug_bounds("shelf-new-my-templates-arrow").unwrap();
    assert!(
        arrow.left() >= label.right(),
        "the arrow follows the words: {label:?} {arrow:?}"
    );

    // 「写给 Agent」 shows the name and one paragraph, the notes; not the
    // description.
    vcx.update(|_, cx| modal.update(cx, |m, cx| m.select(TemplatePick::Library(full), cx)));
    wait(vcx, "the full template's preview", |vcx| {
        vcx.debug_bounds("shelf-new-preview-agent").is_some()
    });
    assert!(vcx.debug_bounds("shelf-new-preview-agent-name").is_some());
    assert!(vcx.debug_bounds("shelf-new-preview-agent-notes").is_some());
    vcx.update(|_, cx| {
        modal.update(cx, |m, cx| {
            m.select(TemplatePick::Library(described.clone()), cx)
        })
    });
    wait(vcx, "the description-only template's preview", |vcx| {
        modal.read_with(vcx, |m, _| m.preview_of(&described).is_some())
    });
    assert!(
        vcx.debug_bounds("shelf-new-preview-agent").is_none(),
        "an Agent with a description alone shows nothing under 写给 Agent"
    );
    lib.close();
}

#[gpui::test]
fn my_templates_rail_order_hover_card_import_export_delete_and_new_dialog_preview(
    cx: &mut TestAppContext,
) {
    let (dir, lib, book_id) = library();

    // Capture dispatched ImportTemplate and ExportTemplate actions.
    let imported_clicks = Rc::new(RefCell::new(0usize));
    let exported_ids: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));

    let (view, vcx) = setup(cx, lib.clone());
    {
        let imp = imported_clicks.clone();
        let exp = exported_ids.clone();
        vcx.update(|_, cx| {
            cx.on_action(move |_: &ImportTemplate, _| {
                *imp.borrow_mut() += 1;
            });
            cx.on_action(move |a: &ExportTemplate, _| {
                exp.borrow_mut().push(a.template.clone());
            });
        });
    }
    let shelf = shelf_of(&view, vcx);
    wait(vcx, "initial shelf loaded", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data.as_ref().is_some_and(|d| d.books.len() == 1)
        })
    });

    // Save template A, export it with author "林舟" to a `.driftingtemplate` file,
    // and import that `.driftingtemplate` file as template B:
    // importing a `.driftingtemplate` NEVER creates a project (`books.len()` stays 1)!
    let tpl_a = lib
        .run::<ProjectTemplateSave>(
            &Actor::User,
            ProjectTemplateSaveIn {
                book: book_id.clone(),
                name: Some("甲模板".into()),
                description: Some("第一份模板".into()),
                locale: None,
                credit: None,
                agent: None,
                exclude_skeleton: Vec::new(),
                sample_entries: Vec::new(),
                view_pins: Vec::new(),
                replace: None,
            },
        )
        .unwrap()
        .output
        .id;

    let tpl_file = dir.path().join("linzhou.driftingtemplate");
    lib.run::<ProjectTemplateExport>(
        &Actor::User,
        ProjectTemplateExportIn {
            id: tpl_a.clone(),
            path: tpl_file.to_string_lossy().into_owned(),
            author: Some("林舟".into()),
        },
    )
    .unwrap();
    next_template_second();
    let tpl_b = lib
        .run::<ProjectTemplateImport>(
            &Actor::User,
            ProjectTemplateImportIn {
                path: tpl_file.to_string_lossy().into_owned(),
            },
        )
        .unwrap()
        .output
        .id;
    lib.run::<ProjectTemplateUpdate>(
        &Actor::User,
        ProjectTemplateUpdateIn {
            id: tpl_b.clone(),
            name: Some("乙模板".into()),
            description: Some("林舟分享的模板".into()),
        },
    )
    .unwrap();

    // Shelf hears the store events immediately and lists `[乙模板, 甲模板]` (newest first),
    // while `books.len()` is still 1!
    wait(vcx, "two templates listed in rail", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data
                .as_ref()
                .is_some_and(|d| d.books.len() == 1 && d.templates.len() == 2)
        })
    });
    assert_eq!(
        shelf.read_with(vcx, |s, _| {
            s.data
                .as_ref()
                .unwrap()
                .templates
                .iter()
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
        }),
        vec![tpl_b.clone(), tpl_a.clone()],
        "templates must be ordered most-recently-updated first"
    );

    // Updating `甲模板` moves `甲模板` to the top of `我的模板`!
    next_template_second();
    lib.run::<ProjectTemplateUpdate>(
        &Actor::User,
        ProjectTemplateUpdateIn {
            id: tpl_a.clone(),
            name: Some("甲模板（新）".into()),
            description: None,
        },
    )
    .unwrap();
    wait(vcx, "updated template moved to top", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.data
                .as_ref()
                .and_then(|d| d.templates.first())
                .is_some_and(|t| t.id == tpl_a && t.name == "甲模板（新）")
        })
    });

    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };

    // The rail draws them in that order too: 甲 above 乙.
    wait(vcx, "rail rows drawn in their new order", |vcx| {
        let a = vcx.debug_bounds(leak(format!("shelf-template-{tpl_a}")));
        let b = vcx.debug_bounds(leak(format!("shelf-template-{tpl_b}")));
        a.zip(b).is_some_and(|(a, b)| a.top() < b.top())
    });

    // Clicking a template row directly does NOTHING (`点一行没反应`).
    let row_b = vcx
        .debug_bounds(leak(format!("shelf-template-{tpl_b}")))
        .expect("template B row drawn");
    vcx.simulate_click(row_b.center(), Modifiers::none());
    vcx.run_until_parked();
    assert!(view.read_with(vcx, |ws, _| ws.shelf_open && ws.book_id.is_empty()));
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);

    // Clicking left-rail 「导入模板」 dispatches `ImportTemplate`.
    let import_tpl_btn = vcx
        .debug_bounds("shelf-import-template")
        .expect("import template cell");
    vcx.simulate_click(import_tpl_btn.center(), Modifiers::none());
    vcx.run_until_parked();
    assert_eq!(*imported_clicks.borrow(), 1);

    // Hovering `乙模板` opens its hover card beside the rail:
    // shows author (`林舟`, no `改自`), `编辑`, `导出（.driftingtemplate）`, `删除`.
    vcx.simulate_mouse_move(row_b.center(), None, Modifiers::none());
    vcx.executor().advance_clock(Duration::from_millis(260));
    wait(vcx, "template hover card opened", |vcx| {
        vcx.debug_bounds(leak(format!("shelf-template-export-{tpl_b}")))
            .is_some()
    });
    assert!(
        vcx.debug_bounds(leak(format!("shelf-template-author-{tpl_b}")))
            .is_some()
    );

    // Clicking `导出（.driftingtemplate）` dispatches `ExportTemplate`.
    let exp_btn = vcx
        .debug_bounds(leak(format!("shelf-template-export-{tpl_b}")))
        .unwrap();
    vcx.simulate_click(exp_btn.center(), Modifiers::none());
    vcx.run_until_parked();
    assert_eq!(*exported_ids.borrow(), vec![tpl_b.clone()]);

    // Open New Project dialog: verify `我的模板` collapses/expands and selecting `乙模板`
    // shows its author (`林舟`) and description in the right pane without `改自`.
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    wait(vcx, "new project dialog with custom templates", |vcx| {
        vcx.debug_bounds("shelf-new-my-templates-toggle").is_some()
    });
    let modal = shelf.read_with(vcx, |s, _| s.new_project_dialog().unwrap());
    assert!(modal.read_with(vcx, |m, _| m.is_my_templates_open()));
    assert!(
        vcx.debug_bounds(leak(format!("shelf-new-pick-{tpl_b}")))
            .is_some()
    );

    // Collapse and re-expand `我的模板`.
    let toggle_btn = vcx.debug_bounds("shelf-new-my-templates-toggle").unwrap();
    vcx.simulate_click(toggle_btn.center(), Modifiers::none());
    vcx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(!modal.read_with(vcx, |m, _| m.is_my_templates_open()));
    assert!(
        vcx.debug_bounds(leak(format!("shelf-new-pick-{tpl_b}")))
            .is_none()
    );

    vcx.simulate_click(toggle_btn.center(), Modifiers::none());
    vcx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(modal.read_with(vcx, |m, _| m.is_my_templates_open()));

    // A preview that cannot be read says so under the dialog (an existing
    // key: 「无法加载预览」) while that template is picked, and 「新建」
    // stays off; a failed read of a template not picked says nothing.
    let tpl_a_pick = TemplatePick::Library(tpl_a.clone());
    vcx.update(|_, cx| {
        modal.update(cx, |m, cx| {
            m.finish_load(&tpl_a, Err("synthetic read failure".into()), cx)
        })
    });
    vcx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(vcx.debug_bounds("shelf-new-error").is_none());
    vcx.update(|_, cx| {
        modal.update(cx, |m, cx| {
            m.select(tpl_a_pick.clone(), cx);
            m.finish_load(&tpl_a, Err("synthetic read failure".into()), cx);
        })
    });
    wait(vcx, "the read failure shows", |vcx| {
        vcx.debug_bounds("shelf-new-error").is_some()
    });
    assert!(modal.read_with(vcx, |m, _| {
        m.selected() == &tpl_a_pick
            && m.selected_value().is_none()
            && m.preview_of(&tpl_a).is_none()
    }));

    let pick_b = vcx
        .debug_bounds(leak(format!("shelf-new-pick-{tpl_b}")))
        .unwrap();
    vcx.simulate_click(pick_b.center(), Modifiers::none());
    wait(vcx, "template B preview loaded in new dialog", |vcx| {
        modal.read_with(vcx, |m, _| {
            m.selected() == &TemplatePick::Library(tpl_b.clone())
                && m.selected_value().is_some_and(|v| v.name == "乙模板")
        }) && vcx.debug_bounds("shelf-new-preview-author").is_some()
            && vcx.debug_bounds("shelf-new-preview-desc").is_some()
    });
    assert!(
        vcx.debug_bounds("shelf-new-error").is_none(),
        "picking another template clears the failure"
    );
    lib.run::<ProjectTemplateUpdate>(
        &Actor::User,
        ProjectTemplateUpdateIn {
            id: tpl_b.clone(),
            name: None,
            description: Some("更新后的结构说明".into()),
        },
    )
    .unwrap();
    wait(vcx, "template preview follows a library update", |vcx| {
        modal.read_with(vcx, |m, _| {
            m.selected_value()
                .is_some_and(|v| v.description == "更新后的结构说明")
        })
    });

    // A preview read that 甲 changed under is dropped, not kept for later.
    let read_before = lib
        .run::<ProjectTemplateGet>(&Actor::User, ProjectTemplateIdIn { id: tpl_a.clone() })
        .unwrap()
        .output;
    next_template_second();
    lib.run::<ProjectTemplateUpdate>(
        &Actor::User,
        ProjectTemplateUpdateIn {
            id: tpl_a.clone(),
            name: Some("甲模板（再改）".into()),
            description: None,
        },
    )
    .unwrap();
    wait(vcx, "the dialog lists 甲's new version", |vcx| {
        modal.read_with(vcx, |m, _| {
            m.my_templates()
                .iter()
                .any(|t| t.id == tpl_a && t.name == "甲模板（再改）")
        })
    });
    vcx.update(|_, cx| {
        modal.update(cx, |m, cx| {
            m.finish_load(&tpl_a, Ok(read_before.clone()), cx)
        })
    });
    assert!(
        modal.read_with(vcx, |m, _| m.preview_of(&tpl_a).is_none()),
        "a read from before 甲 changed must not be kept"
    );
    let read_after = lib
        .run::<ProjectTemplateGet>(&Actor::User, ProjectTemplateIdIn { id: tpl_a.clone() })
        .unwrap()
        .output;
    vcx.update(|_, cx| modal.update(cx, |m, cx| m.finish_load(&tpl_a, Ok(read_after), cx)));
    assert!(modal.read_with(vcx, |m, _| {
        m.preview_of(&tpl_a)
            .is_some_and(|v| v.name == "甲模板（再改）")
    }));

    vcx.simulate_keystrokes("escape");
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);

    // Delete confirmation: ask to delete `甲模板（新）`, cancel via Escape -> NOT deleted!
    let summary_a = shelf.read_with(vcx, |s, _| {
        s.data
            .as_ref()
            .unwrap()
            .templates
            .iter()
            .find(|t| t.id == tpl_a)
            .cloned()
            .unwrap()
    });
    vcx.update(|window, cx| {
        shelf.update(cx, |s, cx| {
            s.ask_delete_template(summary_a.clone(), window, cx)
        });
    });
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.dialog()),
        Some(ShelfDialog::DeleteTemplate(tpl_a.clone()))
    );
    vcx.simulate_keystrokes("escape");
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.data.as_ref().unwrap().templates.len()),
        2,
        "cancelling delete must keep the template"
    );

    // From the hover card itself: 「删除」 asks, the dialog's 「取消」 keeps
    // the template, and its 「删除」 deletes it.
    let open_card_delete = |vcx: &mut VisualTestContext| {
        vcx.simulate_mouse_move(gpui::point(px(900.0), px(600.0)), None, Modifiers::none());
        vcx.executor().advance_clock(Duration::from_millis(400));
        vcx.run_until_parked();
        let row = vcx
            .debug_bounds(leak(format!("shelf-template-{tpl_a}")))
            .expect("甲's row drawn");
        vcx.simulate_mouse_move(row.center(), None, Modifiers::none());
        vcx.executor().advance_clock(Duration::from_millis(260));
        wait(vcx, "甲's hover card opened", |vcx| {
            vcx.debug_bounds(leak(format!("shelf-template-delete-{tpl_a}")))
                .is_some()
        });
        let delete = vcx
            .debug_bounds(leak(format!("shelf-template-delete-{tpl_a}")))
            .unwrap();
        vcx.simulate_click(delete.center(), Modifiers::none());
        wait(vcx, "the delete confirmation is up", |vcx| {
            vcx.debug_bounds("shelf-delete-template-cancel").is_some()
        });
    };
    open_card_delete(vcx);
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.dialog()),
        Some(ShelfDialog::DeleteTemplate(tpl_a.clone()))
    );
    let cancel = vcx.debug_bounds("shelf-delete-template-cancel").unwrap();
    vcx.simulate_click(cancel.center(), Modifiers::none());
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.data.as_ref().unwrap().templates.len()),
        2,
        "「取消」 keeps the template"
    );
    open_card_delete(vcx);
    let confirm = vcx.debug_bounds("shelf-delete-template-confirm").unwrap();
    vcx.simulate_click(confirm.center(), Modifiers::none());
    wait(vcx, "甲 deleted from its card", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.dialog().is_none()
                && s.data
                    .as_ref()
                    .is_some_and(|d| d.templates.iter().all(|t| t.id != tpl_a))
        })
    });

    // Deleting the last one -> `我的模板` disappears once 0 remain!
    let last = shelf.read_with(vcx, |s, _| {
        s.data
            .as_ref()
            .unwrap()
            .templates
            .iter()
            .find(|t| t.id == tpl_b)
            .cloned()
            .unwrap()
    });
    vcx.update(|window, cx| {
        shelf.update(cx, |s, cx| s.ask_delete_template(last, window, cx));
        shelf.update(cx, |s, cx| s.confirm_delete_template(window, cx));
    });
    wait(vcx, "template deleted", |vcx| {
        shelf.read_with(vcx, |s, _| {
            s.dialog().is_none() && s.data.as_ref().is_some_and(|d| d.templates.is_empty())
        })
    });
    assert!(vcx.debug_bounds("shelf-my-templates-section").is_none());

    lib.close();
}
