//! PT3 (`pt3-template-ui`) integration tests across Project Home, All Projects
//! and template working copies (`docs/rust-rewrite/handoff/v5-tracks.md` PT3,
//! `docs/rust-rewrite/project-templates.md` §7, §8, §12, §15 PT3).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_home::{save_template::SaveTemplateDialog, v3::Home};
use dr_view_shelf::{Shelf, ShelfDialog, TemplatePick};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

const VERSION: &str = "0.2.0-dev";

fn seed_library() -> (tempfile::TempDir, std::path::PathBuf, Library, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options(VERSION)).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.rebuild_stale_indexes().unwrap();
    store.close().unwrap();
    let ws = Library::open_dir(&root, VERSION).unwrap();
    (dir, root, ws, book)
}

fn call(ws: &Library, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).expect(name)["output"].clone()
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(30));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "PT3 test timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn setup_app<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    initial_book: Option<&str>,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let mut settings = SettingsFile::in_memory();
    if let Some(b) = initial_book {
        settings.set_last_book(b);
    }
    let book_opt = initial_book.map(str::to_owned);
    let lib_clone = lib.clone();
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
                library: Some(lib_clone),
                book: book_opt,
                ..Services::default()
            },
            settings,
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
        dr_view_home::init(cx);
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(960.0)));
    vcx.update(|window, _| window.activate_window());
    vcx.run_until_parked();
    (ws, vcx)
}

fn home_of(ws: &Entity<Workspace>, vcx: &mut VisualTestContext) -> Entity<Home> {
    ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    })
}

fn shelf_of(ws: &Entity<Workspace>, vcx: &mut VisualTestContext) -> Entity<Shelf> {
    ws.read_with(vcx, |ws, _| {
        ws.shelf.clone().unwrap().view.downcast::<Shelf>().unwrap()
    })
}

#[gpui::test]
fn save_template_dialog_tree_locks_ancestors_agent_isolation_overwrite_and_library_swap(
    cx: &mut TestAppContext,
) {
    let (_dir, root, lib, book) = seed_library();

    // Create a custom unlocked parent level ("设定箱") -> unlocked child level ("附录夹") -> leaf ("样章词条"),
    // and also verify a locked subtree ("要素" -> "人物", where "人物" is mounted on a left-rail Tab,
    // and "书稿" is referenced by both a Tab and storyline's `settings.home`).
    let custom_top = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "设定箱", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let custom_mid = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "附录夹", "parent": custom_top, "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let custom_leaf = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "样章词条", "parent": custom_mid, "level": false}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Set explicit project.agent words on the source project so we can prove editing
    // Agent words in the Save-as dialog only changes the saved template, never the project.
    call(
        &lib,
        "project.update",
        json!({
            "book": book,
            "agent": {
                "name": "原项目名字",
                "description": "原项目说明",
                "instructions": "原项目注意事项"
            }
        }),
    );

    let entries = call(&lib, "entry.list", json!({"book": book, "all": true}));
    let arr = entries.as_array().unwrap();
    let find_id = |title: &str| -> String {
        arr.iter()
            .find(|e| e["title"].as_str() == Some(title))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let manuscript_id = find_id("书稿");
    let elements_id = find_id("要素");
    let characters_id = find_id("人物");
    call(
        &lib,
        "tab.put",
        json!({"book": book, "mount": {"kind": "entry", "entry": characters_id}}),
    );

    let (ws, vcx) = setup_app(cx, &lib, Some(&book));
    wait(vcx, "book opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && !ws.shelf_open)
            && vcx.debug_bounds("v3-home-save-project-template").is_some()
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    wait(vcx, "save button visible", |vcx| {
        vcx.debug_bounds("v3-home-save-project-template").is_some()
    });

    // Click 「另存为项目模板」.
    let save_btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button");
    vcx.simulate_click(save_btn.center(), Modifiers::none());

    wait(vcx, "save dialog loaded", |vcx| {
        ws.read_with(vcx, |ws, cx| {
            ws.dialog
                .as_ref()
                .and_then(|d| d.clone().downcast::<SaveTemplateDialog>().ok())
                .is_some_and(|d| d.read(cx).is_loaded())
        })
    });
    let dialog: Entity<SaveTemplateDialog> = ws.read_with(vcx, |ws, _| {
        ws.dialog
            .clone()
            .unwrap()
            .downcast::<SaveTemplateDialog>()
            .unwrap()
    });

    // 1. Skeleton entries default checked; non-skeleton leaf defaults unchecked.
    assert!(dialog.read_with(vcx, |d, _| d.is_checked(&custom_top)));
    assert!(dialog.read_with(vcx, |d, _| d.is_checked(&custom_mid)));
    assert!(!dialog.read_with(vcx, |d, _| d.is_checked(&custom_leaf)));

    // 2. Locked entries:
    //    - `书稿` is referenced by both a Tab and `settings.home` -> locked with `["左栏", "新条目住在"]`.
    //    - `人物` is referenced by a Tab -> locked with `["左栏"]`, and its residence parent `要素`
    //      is ALSO locked and checked! Attempting to toggle either does nothing.
    assert!(dialog.read_with(vcx, |d, _| d.is_locked(&manuscript_id)));
    assert_eq!(
        dialog.read_with(vcx, |d, cx| d.lock_reasons(&manuscript_id, cx)),
        vec!["左栏".to_string(), "新条目住在".to_string()]
    );
    assert!(dialog.read_with(vcx, |d, _| d.is_locked(&characters_id)));
    assert_eq!(
        dialog.read_with(vcx, |d, cx| d.lock_reasons(&characters_id, cx)),
        vec!["左栏".to_string()]
    );
    assert!(
        dialog.read_with(vcx, |d, _| d.is_locked(&elements_id)
            && d.is_checked(&elements_id)),
        "parent of locked Tab entry must also be locked and checked"
    );
    vcx.update(|_, cx| {
        dialog.update(cx, |d, cx| {
            d.toggle_entry(&manuscript_id, cx);
            d.toggle_entry(&elements_id, cx);
            d.toggle_entry(&characters_id, cx);
        });
    });
    assert!(dialog.read_with(vcx, |d, _| {
        d.is_checked(&manuscript_id) && d.is_checked(&elements_id) && d.is_checked(&characters_id)
    }));

    // 3. Unchecking `设定箱` unchecks its unlocked descendant `附录夹`.
    //    Checking leaf `样章词条` automatically checks its residence ancestors `附录夹` and `设定箱`!
    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.toggle_entry(&custom_top, cx)));
    assert!(!dialog.read_with(vcx, |d, _| d.is_checked(&custom_top)));
    assert!(!dialog.read_with(vcx, |d, _| d.is_checked(&custom_mid)));
    assert!(!dialog.read_with(vcx, |d, _| d.is_checked(&custom_leaf)));

    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.toggle_entry(&custom_leaf, cx)));
    assert!(dialog.read_with(vcx, |d, _| d.is_checked(&custom_leaf)));
    assert!(
        dialog.read_with(vcx, |d, _| d.is_checked(&custom_mid)
            && d.is_checked(&custom_top)),
        "checking a child entry checks all residence ancestors"
    );

    // Uncheck `设定箱` again: `设定箱`, `附录夹`, and `样章词条` all uncheck.
    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.toggle_entry(&custom_top, cx)));
    assert!(!dialog.read_with(vcx, |d, _| {
        d.is_checked(&custom_top) || d.is_checked(&custom_mid) || d.is_checked(&custom_leaf)
    }));

    // Re-check `样章词条` so it goes into the saved template with its ancestors.
    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.toggle_entry(&custom_leaf, cx)));

    // 4. Edit name, description and `写给 Agent` inside the dialog:
    //    saved template gets the edited Agent words; the project itself stays untouched.
    vcx.update(|_, cx| {
        let name_in = dialog.read(cx).name_input().clone();
        let desc_in = dialog.read(cx).description_input().clone();
        let (ag_n, ag_d, ag_i) = {
            let (n, d, i) = dialog.read(cx).agent_inputs();
            (n.clone(), d.clone(), i.clone())
        };
        name_in.update(cx, |f, cx| f.set_text("海港长篇模板", cx));
        desc_in.update(cx, |f, cx| f.set_text("初版描述", cx));
        ag_n.update(cx, |f, cx| f.set_text("模板专属名字", cx));
        ag_d.update(cx, |f, cx| f.set_text("模板专属说明", cx));
        ag_i.update(cx, |f, cx| f.set_text("模板专属注意事项", cx));
    });

    // Click 「新建模板」: saves and closes dialog silently.
    vcx.update(|window, cx| dialog.update(cx, |d, cx| d.submit_new(window, cx)));
    wait(vcx, "save dialog closed after creating template", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_none())
    });

    let list = call(&lib, "project_template.list", json!({}));
    assert_eq!(list.as_array().unwrap().len(), 1);
    let tpl_id = list[0]["id"].as_str().unwrap().to_owned();
    let detail = call(&lib, "project_template.get", json!({"id": tpl_id}));
    assert_eq!(detail["summary"]["name"], "海港长篇模板");
    assert_eq!(detail["summary"]["description"], "初版描述");
    assert_eq!(
        detail["value"]["project"]["agent"],
        json!({
            "name": "模板专属名字",
            "description": "模板专属说明",
            "instructions": "模板专属注意事项"
        })
    );
    let saved_titles: Vec<&str> = detail["value"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["title"].as_str())
        .collect();
    assert!(saved_titles.contains(&"设定箱"));
    assert!(saved_titles.contains(&"附录夹"));
    assert!(saved_titles.contains(&"样章词条"));

    // Source project's own `project.agent` is completely unchanged!
    let proj_after = call(&lib, "project.get", json!({"book": book}));
    assert_eq!(
        proj_after["agent"],
        json!({
            "name": "原项目名字",
            "description": "原项目说明",
            "instructions": "原项目注意事项"
        })
    );

    // 5. Open Save-as again, uncheck `设定箱`, change the dialog's name/description fields
    //    to something else, and use 「覆盖…」 on `海港长篇模板`:
    //    `海港长篇模板` keeps its original name ("海港长篇模板") and description ("初版描述")
    //    while its content updates (`设定箱` gone, revision = 2), without any confirmation dialog!
    let save_btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button");
    vcx.simulate_click(save_btn.center(), Modifiers::none());
    wait(vcx, "second save dialog loaded", |vcx| {
        ws.read_with(vcx, |ws, cx| {
            ws.dialog
                .as_ref()
                .and_then(|d| d.clone().downcast::<SaveTemplateDialog>().ok())
                .is_some_and(|d| d.read(cx).is_loaded())
        })
    });
    let dialog2: Entity<SaveTemplateDialog> = ws.read_with(vcx, |ws, _| {
        ws.dialog
            .clone()
            .unwrap()
            .downcast::<SaveTemplateDialog>()
            .unwrap()
    });
    vcx.update(|window, cx| {
        dialog2.update(cx, |d, cx| {
            d.toggle_entry(&custom_top, cx);
            d.name_input()
                .update(cx, |f, cx| f.set_text("不该覆盖的名字", cx));
            d.description_input()
                .update(cx, |f, cx| f.set_text("不该覆盖的描述", cx));
            d.submit_overwrite(&tpl_id, window, cx);
        });
    });
    wait(vcx, "overwrite finished and closed dialog", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_none())
    });

    let detail2 = call(&lib, "project_template.get", json!({"id": tpl_id}));
    assert_eq!(detail2["summary"]["name"], "海港长篇模板");
    assert_eq!(detail2["summary"]["description"], "初版描述");
    assert_eq!(detail2["summary"]["revision"], 2);
    let titles2: Vec<&str> = detail2["value"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["title"].as_str())
        .collect();
    assert!(!titles2.contains(&"设定箱"));

    // 6. Weak-reference safety (`v3_home_release`): while Save-as dialog is open,
    //    `dr_shell::library::replace` closes and reopens the library without hanging!
    let save_btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button");
    vcx.simulate_click(save_btn.center(), Modifiers::none());
    wait(vcx, "third save dialog loaded", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_some())
    });
    drop(dialog);
    drop(dialog2);
    drop(lib);

    let replaced = Rc::new(RefCell::new(None));
    let replaced_done = replaced.clone();
    vcx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            move |opened_root, options| {
                assert_eq!(opened_root, root);
                dr_store::Library::open(opened_root, options).map_err(|e| e.to_string())
            },
            move |res, _| {
                *replaced_done.borrow_mut() = Some(res);
            },
        );
    });
    wait(
        vcx,
        "library::replace succeeded while dialog was open",
        |_| replaced.borrow().is_some(),
    );
    assert_eq!(replaced.borrow_mut().take().unwrap(), Ok(()));

    let reopened_lib = vcx.update(|_, cx| cx.global::<Services>().library.clone().unwrap());
    reopened_lib.close();
}

#[gpui::test]
fn edit_template_working_copy_autosaves_undoes_and_red_light_returns_to_shelf_then_new_project_selects_title(
    cx: &mut TestAppContext,
) {
    let (_dir, _root, lib, book) = seed_library();

    let tpl_id = call(
        &lib,
        "project_template.save",
        json!({
            "book": book,
            "name": "双线长篇",
            "description": "两条时间线并行推进"
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Start on All Projects (`initial_book: None`).
    let (ws, vcx) = setup_app(cx, &lib, None);
    let shelf = shelf_of(&ws, vcx);
    wait(vcx, "shelf loaded with saved template", |vcx| {
        ws.read_with(vcx, |ws, _| ws.shelf_open)
            && shelf.read_with(vcx, |s, _| {
                s.data
                    .as_ref()
                    .is_some_and(|d| d.books.len() == 1 && d.templates.len() == 1)
            })
    });
    assert!(vcx.debug_bounds("shelf-my-templates-header").is_some());

    // 1. Open template working copy via `edit_template` (hover card's 「编辑」).
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.edit_template(&tpl_id, window, cx)));
    wait(vcx, "working copy opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| {
            !ws.shelf_open && !ws.book_id.is_empty() && ws.book.id == ws.book_id
        }) && home_of(&ws, vcx).read_with(vcx, |h, _| h.template_workspace() && h.loaded.is_some())
    });
    let copy_book = ws.read_with(vcx, |ws, _| ws.book_id.clone());
    assert_ne!(copy_book, book);
    assert!(lib.is_working_copy(&copy_book).unwrap());

    // Working copy has NO top banner, NO save/discard buttons, and Project Home
    // hides source row, save-as button, and top word/today lines.
    assert!(vcx.debug_bounds("v3-home-save-project-template").is_none());
    assert!(vcx.debug_bounds("v3-home-template-source").is_none());
    assert!(vcx.debug_bounds("v3-home-words").is_none());
    assert!(vcx.debug_bounds("v3-home-today").is_none());

    // Working copy is excluded from `ShelfData.books`.
    let shelf_check = dr_view_shelf::data::ShelfData::load(&lib).unwrap();
    assert!(shelf_check.books.iter().all(|b| b.id != copy_book));

    // 2. Modify an entry template in the working copy -> auto-saves into `project-template:<id>`
    //    without clicking any Save button; undo one step -> template reverts automatically!
    let mut chapter_tpl = call(&lib, "entry_template.list", json!({"book": copy_book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"].as_str() == Some("tpl-chapter"))
        .unwrap()
        .clone();
    let orig_tpl_name = chapter_tpl["name"].as_str().unwrap().to_owned();
    chapter_tpl["name"] = json!("章节（改）");
    call(
        &lib,
        "entry_template.put",
        json!({"book": copy_book, "template": chapter_tpl}),
    );

    // Wait for DW's background `Saver` (250ms debounce) to save into `project-template:<id>`.
    wait(vcx, "working copy auto-saved entry template edit", |_| {
        let val = &call(&lib, "project_template.get", json!({"id": tpl_id}))["value"];
        val["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == "tpl-chapter" && t["name"] == "章节（改）")
    });

    // Undo one step in the working copy -> template follows back!
    lib.undo_in(&Actor::User, &copy_book, None).unwrap();
    wait(vcx, "working copy undo reverted template", |_| {
        let val = &call(&lib, "project_template.get", json!({"id": tpl_id}))["value"];
        val["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == "tpl-chapter" && t["name"] == orig_tpl_name)
    });

    // Leaving the working copy also commits the focused inline field.
    let synopsis = home_of(&ws, vcx).read_with(vcx, |h, _| h.synopsis_input().clone());
    vcx.update(|window, cx| {
        synopsis.update(cx, |field, cx| {
            field.focus_handle(cx).focus(window, cx);
            field.select_all_text(cx);
        });
    });
    vcx.simulate_input("修订后的梗概");

    // 3. Clicking the window's red close light (`simulate_close`) inside the working copy
    //    does NOT close the window (`returns false`) and does NOT prompt: it steps straight
    //    back to 「全部项目」!
    assert!(
        !vcx.simulate_close(),
        "red close light in a template working copy must return to All projects without closing the window"
    );
    assert!(ws.read_with(vcx, |ws, _| ws.shelf_open && ws.dialog.is_none()));
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    wait(vcx, "leaving saved the focused synopsis", |_| {
        call(&lib, "project_template.get", json!({"id": tpl_id}))["summary"]["description"]
            == "修订后的梗概"
    });

    // 4. Open 「新建项目」 dialog, pick `双线长篇`, click 「新建」:
    //    creates project named 「未命名」, opens on Project Home with `来自「双线长篇」`,
    //    inline title is focused and selected, so typing immediately renames the project!
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.start_create(window, cx)));
    assert_eq!(
        shelf.read_with(vcx, |s, _| s.dialog()),
        Some(ShelfDialog::Create)
    );
    let modal = shelf
        .read_with(vcx, |s, _| s.new_project_dialog())
        .expect("new project modal");
    assert_eq!(
        modal.read_with(vcx, |m, _| m.selected().clone()),
        TemplatePick::Builtin
    );

    // Select `双线长篇` and wait for right-pane preview to load its value.
    vcx.update(|_, cx| {
        modal.update(cx, |m, cx| {
            m.select(TemplatePick::Library(tpl_id.clone()), cx)
        });
    });
    wait(vcx, "custom template preview loaded", |vcx| {
        modal.read_with(vcx, |m, _| {
            m.selected_value()
                .is_some_and(|v| v.name == "双线长篇" && v.description == "修订后的梗概")
        })
    });

    vcx.update(|window, cx| modal.update(cx, |m, cx| m.submit(window, cx)));
    wait(vcx, "new project opened on Project Home", |vcx| {
        ws.read_with(vcx, |ws, _| {
            !ws.shelf_open
                && ws.book_id != copy_book
                && ws.book_id != book
                && ws.book.name == "未命名"
                && ws.nav.current().is_none()
        }) && vcx.debug_bounds("v3-home-template-source").is_some()
    });

    let created_book = ws.read_with(vcx, |ws, _| ws.book_id.clone());
    let home = home_of(&ws, vcx);
    assert_eq!(
        home.read_with(vcx, |h, cx| h.template_source_text(cx))
            .as_deref(),
        Some("来自「双线长篇」")
    );

    // Title input is focused AND all of "未命名" is selected, so typing replaces it!
    let title_in = home.read_with(vcx, |h, _| h.title_input().clone());
    let (is_focused, selected_range, current_text) = vcx.update(|window, cx| {
        let f = title_in.read(cx);
        (
            f.focus_handle(cx).is_focused(window),
            f.composer().selection(),
            f.text(),
        )
    });
    assert!(is_focused, "newly created project title must be focused");
    assert_eq!(current_text, "未命名");
    assert_eq!(
        selected_range,
        0.."未命名".len(),
        "newly created project title must be selected so typing replaces 未命名"
    );

    // Simulate typing directly + Enter -> replaces "未命名" with "新港纪事"!
    vcx.simulate_input("新港纪事");
    vcx.simulate_keystrokes("enter");
    wait(vcx, "typed project name saved", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.name == "新港纪事")
    });
    assert_eq!(
        call(&lib, "book.get", json!({"book": created_book}))["name"],
        "新港纪事"
    );

    // In an ordinary project, the red close light DOES close the window.
    assert!(vcx.simulate_close());
    lib.close();
}
