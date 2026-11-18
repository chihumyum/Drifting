//! PT3 (`pt3-template-ui`) integration tests across Project Home, All Projects
//! and template working copies (`docs/rust-rewrite/handoff/v5-tracks.md` PT3,
//! `docs/rust-rewrite/project-templates.md` §7, §8, §12, §15 PT3).

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
};
use dr_view_home::{save_template::SaveTemplateDialog, v3::Home};
use dr_view_shelf::{Shelf, ShelfDialog, TemplatePick, projects::Projects};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    AppContext as _, Entity, Focusable as _, Modifiers, Render, TestAppContext, VisualTestContext,
    px, size,
};
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

/// A dialog that only stands over the page, for the red light.
struct OverPage;

impl Render for OverPage {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div()
    }
}

fn secondary(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("cmd-{key}")
    } else {
        format!("ctrl-{key}")
    }
}

fn setup_app<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    initial_book: Option<&str>,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    setup_app_with(cx, lib, initial_book, false)
}

/// `pages`: the entry pages and their prose editors too (`dr-view-page`).
fn setup_app_with<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    initial_book: Option<&str>,
    pages: bool,
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
        if pages {
            dr_view_page::init(cx);
        }
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
    // A second view, so the time pins have one ticked and one not.
    call(
        &lib,
        "timeline_view.put",
        json!({"book": book, "view": {"id": "pt3-second-view", "name": "回忆的顺序", "lanes": []}}),
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

    // 0. The time pins start as the prototype's `saveDefaults` has them: the
    //    first view ticked, the others not.
    let views = dialog.read_with(vcx, |d, _| d.view_items().to_vec());
    assert!(views.len() >= 2, "{views:?}");
    assert!(dialog.read_with(vcx, |d, _| d.is_view_pin_checked(&views[0].id)));
    for view in &views[1..] {
        assert!(!dialog.read_with(vcx, |d, _| d.is_view_pin_checked(&view.id)));
    }

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
    // Clicking the locked rows themselves does nothing (书稿 is the first
    // row; folding it brings 要素 and 人物 up).
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let click = |vcx: &mut VisualTestContext, selector: String| {
        let bounds = vcx
            .debug_bounds(leak(selector.clone()))
            .unwrap_or_else(|| panic!("{selector} drawn"));
        vcx.simulate_click(bounds.center(), Modifiers::none());
        vcx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    };
    click(vcx, format!("v3-save-tpl-entry-{manuscript_id}"));
    click(vcx, format!("v3-save-tpl-disc-{manuscript_id}"));
    click(vcx, format!("v3-save-tpl-entry-{elements_id}"));
    click(vcx, format!("v3-save-tpl-entry-{characters_id}"));
    assert!(dialog.read_with(vcx, |d, _| {
        d.is_checked(&manuscript_id) && d.is_checked(&elements_id) && d.is_checked(&characters_id)
    }));
    assert!(dialog.read_with(vcx, |d, _| {
        d.is_locked(&manuscript_id) && d.is_locked(&elements_id) && d.is_locked(&characters_id)
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
    vcx.update(|_, cx| {
        dialog2.update(cx, |d, cx| {
            d.toggle_entry(&custom_top, cx);
            d.name_input()
                .update(cx, |f, cx| f.set_text("不该覆盖的名字", cx));
            d.description_input()
                .update(cx, |f, cx| f.set_text("不该覆盖的描述", cx));
        });
    });
    // 「覆盖…」 opens the list of my templates above the button, its right
    // edge on the button's, 220 wide (the prototype); picking one saves over
    // it at once, without a question.
    wait(vcx, "覆盖… drawn", |vcx| {
        vcx.debug_bounds("v3-save-tpl-overwrite").is_some()
    });
    let overwrite = vcx.debug_bounds("v3-save-tpl-overwrite").unwrap();
    vcx.simulate_click(overwrite.center(), Modifiers::none());
    let item = leak(format!("v3-save-tpl-overwrite-item-{tpl_id}"));
    wait(vcx, "the overwrite list is up", |vcx| {
        vcx.debug_bounds(item).is_some()
    });
    let row = vcx.debug_bounds(item).unwrap();
    assert!(
        row.bottom() <= overwrite.top(),
        "the list opens upward, clear of the buttons: {row:?} over {overwrite:?}"
    );
    let inset = f32::from(overwrite.right() - row.right());
    let width = f32::from(row.size.width) + 2.0 * inset;
    assert!(
        (0.0..=12.0).contains(&inset) && (width - 220.0).abs() <= 1.0,
        "right-aligned and 220 wide: row {row:?}, button {overwrite:?}"
    );
    vcx.simulate_click(row.center(), Modifiers::none());
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
        ws.read_with(vcx, |ws, cx| {
            ws.dialog
                .as_ref()
                .and_then(|d| d.clone().downcast::<SaveTemplateDialog>().ok())
                .is_some_and(|d| d.read(cx).is_loaded())
        })
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
    assert!(
        ws.read_with(vcx, |ws, _| ws.dialog.is_none()),
        "the library swap closes the open save dialog"
    );

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

    // Undo one step in the working copy with ⌘Z, the workspace's own key
    // path -> template follows back!
    vcx.update(|window, cx| {
        let focus = ws.read(cx).focus_handle().clone();
        focus.focus(window, cx);
        window.draw(cx).clear(cx);
    });
    vcx.simulate_keystrokes(&secondary("z"));
    wait(vcx, "working copy undo reverted template", |_| {
        let val = &call(&lib, "project_template.get", json!({"id": tpl_id}))["value"];
        val["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == "tpl-chapter" && t["name"] == orig_tpl_name)
    });

    // Leaving the working copy closes what floats over it (a dialog,
    // Settings) and commits the focused inline field.
    vcx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.open_settings(window, cx));
        let over = cx.new(|_| OverPage);
        dr_shell::dialogs::show_in(window.window_handle(), cx, over.into());
    });
    wait(vcx, "a dialog and Settings over the working copy", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_some() && ws.settings.is_some())
    });
    let synopsis = home_of(&ws, vcx).read_with(vcx, |h, _| h.synopsis_input().clone());
    vcx.update(|window, cx| {
        synopsis.update(cx, |field, cx| {
            field.focus_handle(cx).focus(window, cx);
            field.select_all_text(cx);
        });
        window.draw(cx).clear(cx);
    });
    vcx.simulate_input("修订后的梗概");

    // 3. Clicking the window's red close light (`simulate_close`) inside the working copy
    //    does NOT close the window (`returns false`) and does NOT prompt: it steps straight
    //    back to 「全部项目」, with nothing left floating over it.
    assert!(
        !vcx.simulate_close(),
        "red close light in a template working copy must return to All projects without closing the window"
    );
    assert!(ws.read_with(vcx, |ws, _| {
        ws.shelf_open && ws.dialog.is_none() && ws.settings.is_none() && ws.history.is_none()
    }));
    assert_eq!(shelf.read_with(vcx, |s, _| s.dialog()), None);
    wait(vcx, "leaving saved the focused synopsis", |_| {
        call(&lib, "project_template.get", json!({"id": tpl_id}))["summary"]["description"]
            == "修订后的梗概"
    });

    // Reopened for editing, the working copy shows what was typed before the
    // red light; the red light takes it back to 全部项目 again.
    vcx.update(|window, cx| shelf.update(cx, |s, cx| s.edit_template(&tpl_id, window, cx)));
    wait(vcx, "working copy reopened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| !ws.shelf_open && ws.book.id == ws.book_id)
            && home_of(&ws, vcx).read_with(vcx, |h, _| h.template_workspace() && h.loaded.is_some())
    });
    let synopsis = home_of(&ws, vcx).read_with(vcx, |h, _| h.synopsis_input().clone());
    wait(vcx, "the reopened synopsis", |vcx| {
        synopsis.read_with(vcx, |f, _| f.text()) == "修订后的梗概"
    });
    assert!(!vcx.simulate_close());
    assert!(ws.read_with(vcx, |ws, _| ws.shelf_open));

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

#[gpui::test]
fn save_template_dialog_locks_a_nested_home_target_and_not_a_trashed_templates_home(
    cx: &mut TestAppContext,
) {
    let (_dir, _root, lib, book) = seed_library();
    let entries = call(&lib, "entry.list", json!({"book": book, "all": true}));
    let arr = entries.as_array().unwrap();
    let roots: Vec<String> = arr
        .iter()
        .filter(|e| e["parent"].is_null())
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    // Two levels of the author's, one inside the other, that nothing else
    // points at (the seed's 要素 is on a left-rail Tab).
    let outer_id = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "外层", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let inner_id = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "内层", "parent": outer_id, "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // A live template whose 「新条目住在」 is 内层, a level inside 外层.
    let template = |id: &str, name: &str, home: &str| {
        json!({
            "book": book,
            "template": {
                "id": id,
                "name": name,
                "level": true,
                "linkable": false,
                "modules": [],
                "settings": {"accept": true, "home": home}
            }
        })
    };
    call(
        &lib,
        "entry_template.put",
        template("tpl-pt3-nested-home", "收内层", &inner_id),
    );
    // A template in the trash pointing at a level of its own holds nothing.
    let spare = call(
        &lib,
        "entry.create",
        json!({"book": book, "title": "空置层", "level": true}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &lib,
        "entry_template.put",
        template("tpl-pt3-trashed-home", "已删的模板", &spare),
    );
    call(
        &lib,
        "entry_template.delete",
        json!({"book": book, "id": "tpl-pt3-trashed-home"}),
    );
    let trashed = call(&lib, "entry_template.list", json!({"book": book}));
    assert!(
        trashed
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["id"] != "tpl-pt3-trashed-home" || !t["deleted_at"].is_null()),
        "the template is in the trash: {trashed:#}"
    );

    let (ws, vcx) = setup_app(cx, &lib, Some(&book));
    wait(vcx, "book opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && !ws.shelf_open)
            && vcx.debug_bounds("v3-home-save-project-template").is_some()
    });
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

    // 内层 is held with its reason, and 外层 above it with it (no reason of
    // its own).
    assert!(dialog.read_with(vcx, |d, _| d.is_locked(&inner_id)));
    assert!(
        dialog
            .read_with(vcx, |d, cx| d.lock_reasons(&inner_id, cx))
            .contains(&"新条目住在".to_string())
    );
    assert!(dialog.read_with(vcx, |d, _| d.is_locked(&outer_id)
        && d.is_checked(&outer_id)));
    assert_eq!(
        dialog.read_with(vcx, |d, cx| d.lock_reasons(&outer_id, cx)),
        Vec::<String>::new()
    );

    // Clicking 外层's row (the other roots folded, so it is in sight) does
    // nothing.
    for root in roots.iter().filter(|r| **r != outer_id) {
        let disc: &'static str = Box::leak(format!("v3-save-tpl-disc-{root}").into_boxed_str());
        if let Some(bounds) = vcx.debug_bounds(disc) {
            vcx.simulate_click(bounds.center(), Modifiers::none());
            vcx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
        }
    }
    let row: &'static str = Box::leak(format!("v3-save-tpl-entry-{outer_id}").into_boxed_str());
    let bounds = vcx.debug_bounds(row).expect("外层's row drawn");
    vcx.simulate_click(bounds.center(), Modifiers::none());
    vcx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(dialog.read_with(vcx, |d, _| {
        d.is_checked(&outer_id) && d.is_checked(&inner_id) && d.is_locked(&outer_id)
    }));

    // The trashed template's 「新条目住在」 locks nothing: 空置层 is ticked
    // as a level and can be unticked.
    assert!(!dialog.read_with(vcx, |d, _| d.is_locked(&spare)));
    assert!(dialog.read_with(vcx, |d, _| d.is_checked(&spare)));
    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.toggle_entry(&spare, cx)));
    assert!(!dialog.read_with(vcx, |d, _| d.is_checked(&spare)));

    vcx.update(|_, cx| dialog.update(cx, |d, cx| d.close(cx)));
    lib.close();
}

#[gpui::test]
fn new_project_from_the_row_of_projects_holds_the_keyboard(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let chapter = call(&lib, "entry.list", json!({"book": book, "all": true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (ws, vcx) = setup_app_with(cx, &lib, Some(&book), true);
    wait(vcx, "book opened", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && !ws.shelf_open)
    });

    // The chapter's prose has the keyboard.
    let target = Target::Entry {
        id: chapter.parse().unwrap(),
        module: Some("mod-prose".parse().unwrap()),
    };
    ws.update(vcx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(vcx, "chapter editor mounted", |vcx| {
        ws.read_with(vcx, |ws, _| ws.editor_of(&target).is_some())
    });
    let editor = ws.read_with(vcx, |ws, _| ws.editor_of(&target).unwrap().clone());
    let prose_focus = vcx.update(|window, cx| {
        let focus = editor.read(cx).editor().focus_handle(cx);
        focus.focus(window, cx);
        window.draw(cx).clear(cx);
        focus
    });
    let before = vcx.update(|_, cx| editor.read(cx).plain_text(cx));

    // 「新建项目」 from the row of projects.
    vcx.dispatch_action(dr_shell::actions::ToggleProjects);
    let projects = ws
        .read_with(vcx, |ws, _| ws.projects.clone())
        .expect("row of projects mounted")
        .downcast::<Projects>()
        .expect("projects view");
    // Once the row has come all the way down (its head right under the
    // title bar), the button is where a click finds it.
    wait(vcx, "row of projects down", |vcx| {
        vcx.debug_bounds("projects-new")
            .is_some_and(|b| f32::from(b.top()) >= dr_shell::workspace::TITLEBAR_HEIGHT - 0.5)
    });
    let open_dialog = |vcx: &mut VisualTestContext| {
        let new = vcx.debug_bounds("projects-new").unwrap();
        vcx.simulate_click(new.center(), Modifiers::none());
        wait(vcx, "new project dialog drawn", |vcx| {
            vcx.debug_bounds("shelf-new-left-pane").is_some()
        });
        projects
            .read_with(vcx, |p, _| p.new_project_dialog())
            .expect("dialog open")
    };
    let modal = open_dialog(vcx);
    assert!(vcx.update(|window, cx| modal.focus_handle(cx).is_focused(window)));
    assert!(!vcx.update(|window, _| prose_focus.is_focused(window)));

    // Typing goes nowhere under the dialog: the prose is as it was.
    vcx.simulate_input("不该进正文");
    vcx.update(|window, cx| window.draw(cx).clear(cx));
    assert_eq!(vcx.update(|_, cx| editor.read(cx).plain_text(cx)), before);

    // Esc closes the dialog and nothing else; the keyboard is back in the
    // prose.
    vcx.simulate_keystrokes("escape");
    assert!(projects.read_with(vcx, |p, _| p.new_project_dialog().is_none()));
    assert!(ws.read_with(vcx, |ws, _| ws.projects_open));
    assert!(vcx.update(|window, _| prose_focus.is_focused(window)));

    // ⌘↵ creates the project and opens it.
    let _ = open_dialog(vcx);
    vcx.simulate_keystrokes(&secondary("enter"));
    wait(vcx, "⌘↵ created and opened the project", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book_id != book && ws.book.name == "未命名" && !ws.projects_open
        })
    });
    lib.close();
}

/// UP (kernel-v5 §15 item 50, P8 甲): the save dialog's 「条目」 box is as
/// tall as the right column; it stopped short of it at a fixed height.
#[gpui::test]
fn save_template_dialogs_tree_reaches_the_right_columns_foot(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let (ws, vcx) = setup_app(cx, &lib, Some(&book));
    wait(vcx, "book opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && !ws.shelf_open)
            && vcx.debug_bounds("v3-home-save-project-template").is_some()
    });
    let save_btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button");
    vcx.simulate_click(save_btn.center(), Modifiers::none());
    wait(vcx, "save dialog drawn", |vcx| {
        ws.read_with(vcx, |ws, cx| {
            ws.dialog
                .as_ref()
                .and_then(|d| d.clone().downcast::<SaveTemplateDialog>().ok())
                .is_some_and(|d| d.read(cx).is_loaded())
        }) && vcx.debug_bounds("v3-save-tpl-form-scroll").is_some()
    });
    // These are the visible tree frame and the right scroll pane, not
    // their outer flex containers. They stay aligned when a shorter
    // window makes the form scroll, and after growing the window again.
    for (width, height) in [
        (1280.0, 960.0),
        (1280.0, 700.0),
        (1100.0, 1200.0),
        (1280.0, 960.0),
    ] {
        vcx.simulate_resize(size(px(width), px(height)));
        vcx.run_until_parked();
        vcx.update(|window, cx| window.draw(cx).clear(cx));
        let tree = vcx.debug_bounds("v3-save-tpl-tree").unwrap();
        let form = vcx.debug_bounds("v3-save-tpl-form-scroll").unwrap();
        assert!(
            tree.size.height > px(100.0),
            "the visible tree frame: {tree:?}"
        );
        assert!(
            form.size.height > px(100.0),
            "the visible form pane: {form:?}"
        );
        assert!(tree.origin.y >= px(0.0) && tree.bottom() <= px(height));
        assert!(form.origin.y >= px(0.0) && form.bottom() <= px(height));
        assert!(
            (tree.bottom() - form.bottom()).abs() <= px(1.0),
            "at {width}x{height}, the tree ends at {:?}, the right column at {:?}",
            tree.bottom(),
            form.bottom()
        );
    }
}

#[gpui::test]
fn saving_a_template_locks_the_form_and_distinguishes_load_and_write_failures(
    cx: &mut TestAppContext,
) {
    use dr_view_home::SaveProjectTemplateHost;
    use gpui::EntityInputHandler as _;

    let (_dir, _root, lib, book) = seed_library();
    let (ws, vcx) = setup_app(cx, &lib, Some(&book));
    wait(vcx, "book ready", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == book && !ws.shelf_open)
    });

    let open = |book_id: String, vcx: &mut VisualTestContext| {
        vcx.update(|window, cx| {
            dr_view_home::save_template::open(
                SaveProjectTemplateHost {
                    workspace: ws.downgrade(),
                    library: lib.downgrade(),
                    book_id,
                },
                window,
                cx,
            );
        });
        wait(vcx, "save dialog mounted", |vcx| {
            ws.read_with(vcx, |ws, _| ws.dialog.is_some())
        });
        ws.read_with(vcx, |ws, _| {
            ws.dialog
                .clone()
                .unwrap()
                .downcast::<SaveTemplateDialog>()
                .unwrap()
        })
    };

    let missing = open("missing-synthetic-project".into(), vcx);
    wait(vcx, "read project failure", |vcx| {
        vcx.debug_bounds("projectTemplates.readProjectFailed")
            .is_some()
            && vcx.debug_bounds("v3-save-tpl-error-warning").is_some()
    });
    missing.update(vcx, |_, cx| {
        let id = cx.entity_id();
        dr_shell::dialogs::hide(cx, id);
    });

    let dialog = open(book, vcx);
    wait(vcx, "save form ready", |vcx| {
        dialog.read_with(vcx, |d, _| d.is_loaded())
    });
    let (fields, areas) = dialog.read_with(vcx, |d, _| {
        let (agent_name, agent_desc, agent_instructions) = d.agent_inputs();
        (
            [
                d.name_input().clone(),
                agent_name.clone(),
                agent_desc.clone(),
            ],
            [d.description_input().clone(), agent_instructions.clone()],
        )
    });
    vcx.update(|window, cx| {
        dialog.update(cx, |d, cx| {
            d.submit_overwrite("missing-synthetic-template", window, cx);
            assert!(d.is_busy());
        });
        // Try the same IME insertion the text controls receive from the OS,
        // in this dispatch, while the background write still owns the form.
        for field in &fields {
            field.update(cx, |field, cx| {
                field.focus_handle(cx).focus(window, cx);
                let before = field.text();
                field.replace_text_in_range(None, " x", window, cx);
                assert_eq!(field.text(), before);
            });
        }
        for area in &areas {
            area.update(cx, |area, cx| {
                area.focus_handle(cx).focus(window, cx);
                let before = area.text();
                area.replace_text_in_range(None, " x", window, cx);
                assert_eq!(area.text(), before);
            });
        }
    });
    wait(vcx, "write failure", |vcx| {
        vcx.debug_bounds("projectTemplates.saveFailed").is_some()
            && vcx.debug_bounds("v3-save-tpl-error-warning").is_some()
    });
    assert!(!dialog.read_with(vcx, |d, _| d.is_busy()));
    vcx.update(|window, cx| {
        for field in &fields {
            field.update(cx, |field, cx| {
                field.focus_handle(cx).focus(window, cx);
                let before = field.text();
                field.replace_text_in_range(None, " x", window, cx);
                assert_ne!(field.text(), before);
            });
        }
        for area in &areas {
            area.update(cx, |area, cx| {
                area.focus_handle(cx).focus(window, cx);
                let before = area.text();
                area.replace_text_in_range(None, " x", window, cx);
                assert_ne!(area.text(), before);
            });
        }
    });
    assert_eq!(
        vcx.update(|_, cx| dr_shell::t(cx, dr_i18n::keys::project_templates::READ_PROJECT_FAILED)),
        "没能读出这个项目。"
    );
    assert_eq!(
        vcx.update(|_, cx| dr_shell::t(cx, dr_i18n::keys::project_templates::SAVE_FAILED)),
        "没能另存为模板，请重试。"
    );
}
