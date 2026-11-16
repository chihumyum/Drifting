//! Regression tests for Track T2 Project Home (`kernel-v5.md` §2 & §3,
//! `docs/rust-rewrite/handoff/v5-tracks.md` T2).

use std::{
    cell::RefCell,
    path::Path,
    rc::Rc,
    time::{Duration, Instant},
};

use dr_agent_tools::structure::StructureContext;
use dr_model::id::BookId;
use dr_shell::{Services, Settings, SettingsFile, ShellInfo, Workspace};
use dr_view_home::{
    Field, SaveProjectTemplateHost, clear_save_project_template, focus_project_title,
    has_save_project_template, set_save_project_template, v3::Home,
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{Entity, Focusable as _, Modifiers, TestAppContext, VisualTestContext, px, size};
use serde_json::{Value, json};

fn seed_library() -> (tempfile::TempDir, std::path::PathBuf, Library, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let store = dr_store::Library::open(&root, dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.rebuild_stale_indexes().unwrap();
    store.close().unwrap();
    let lib = Library::open_dir(&root, "test").unwrap();
    (dir, root, lib, book)
}

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn undo(lib: &Library) {
    lib.undo(&Actor::User)
        .expect("undo call succeeded")
        .expect("undo step existed");
}

fn wait(cx: &mut VisualTestContext, stage: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if done(cx) {
            break;
        }
        assert!(Instant::now() < deadline, "home timed out: {stage}");
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn open_workspace<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, Entity<Home>, &'a mut VisualTestContext) {
    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 15).unwrap();
    cx.executor().allow_parking();
    cx.update(|cx| {
        let mut settings = SettingsFile::in_memory();
        settings
            .set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .unwrap();
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "test",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.to_owned()),
                ..Default::default()
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
        clear_save_project_template(cx);
        dr_view_home::init(cx);
        dr_view_home::set_today(day, cx);
    });
    let (ws, vcx) = cx.add_window_view(Workspace::new);
    vcx.simulate_resize(size(px(1280.0), px(1400.0)));
    vcx.update(|window, _| window.activate_window());
    wait(vcx, "workspace book ready", |vcx| {
        ws.read_with(vcx, |ws, _| {
            ws.book.id == book && ws.book.v3().is_some() && ws.v3_home.is_some()
        })
    });
    ws.update(vcx, |ws, cx| ws.open_home(cx));
    let home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "home initial numbers", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some())
            && vcx.debug_bounds("v3-home-project-template").is_some()
    });
    (ws, home, vcx)
}

#[gpui::test]
fn inline_title_and_synopsis_save_reopen_and_undo_one_step_each(cx: &mut TestAppContext) {
    let (_dir, root, lib, book) = seed_library();
    let initial = call(&lib, "book.get", json!({ "book": book }));
    let initial_name = initial["name"].as_str().unwrap().to_owned();
    let initial_summary = initial["summary"].as_str().unwrap().to_owned();

    let (ws, home, vcx) = open_workspace(cx, &lib, &book);

    // Settings button and dialog no longer exist on Project Home.
    assert!(vcx.debug_bounds("v3-home-settings").is_none());
    assert!(ws.read_with(vcx, |ws, _| ws.dialog.is_none()));
    assert!(vcx.debug_bounds("v3-home-title-input").is_some());
    assert!(vcx.debug_bounds("v3-home-synopsis-input").is_some());

    let (title_in, synopsis_in) = home.read_with(vcx, |h, _| {
        (h.title_input().clone(), h.synopsis_input().clone())
    });
    assert_eq!(title_in.read_with(vcx, |f, _| f.text()), initial_name);
    assert_eq!(synopsis_in.read_with(vcx, |f, _| f.text()), initial_summary);

    // 1. Edit title inline -> 1 project.update write.
    vcx.update(|_, cx| {
        title_in.update(cx, |f, cx| f.set_text("潮声北归", cx));
        home.update(cx, |h, cx| h.store_title(cx));
    });
    wait(vcx, "title saved", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && ws.read_with(vcx, |ws, _| ws.book.name == "潮声北归")
    });
    assert_eq!(
        call(&lib, "book.get", json!({ "book": book }))["name"],
        "潮声北归"
    );

    // Whitespace-only title reverts to stored title without writing an undo step.
    vcx.update(|_, cx| {
        title_in.update(cx, |f, cx| f.set_text("   ", cx));
        home.update(cx, |h, cx| h.store_title(cx));
    });
    assert_eq!(title_in.read_with(vcx, |f, _| f.text()), "潮声北归");

    // 2. Edit synopsis inline -> 1 project.update write.
    let new_synopsis = "一艘老驳船穿过冻港，把旧账带回岸上。";
    vcx.update(|_, cx| {
        synopsis_in.update(cx, |f, cx| f.set_text(new_synopsis, cx));
        home.update(cx, |h, cx| h.store_synopsis(cx));
    });
    wait(vcx, "synopsis saved", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && home.read_with(vcx, |h, _| {
                h.loaded.as_ref().is_some_and(|d| d.summary == new_synopsis)
            })
    });
    assert_eq!(
        call(&lib, "book.get", json!({ "book": book }))["summary"],
        new_synopsis
    );

    // 3. Undo synopsis in 1 step, then undo title in 1 step, verifying live UI sync.
    undo(&lib);
    wait(vcx, "synopsis undone", |vcx| {
        synopsis_in.read_with(vcx, |f, _| f.text()) == initial_summary
    });
    assert_eq!(title_in.read_with(vcx, |f, _| f.text()), "潮声北归");
    assert_eq!(
        call(&lib, "book.get", json!({ "book": book }))["summary"],
        initial_summary
    );

    undo(&lib);
    wait(vcx, "title undone", |vcx| {
        title_in.read_with(vcx, |f, _| f.text()) == initial_name
    });
    assert_eq!(
        call(&lib, "book.get", json!({ "book": book }))["name"],
        initial_name
    );

    // Re-apply both edits and verify they survive closing and reopening the library from disk.
    vcx.update(|_, cx| {
        title_in.update(cx, |f, cx| f.set_text("潮声北归", cx));
        home.update(cx, |h, cx| h.store_title(cx));
        synopsis_in.update(cx, |f, cx| f.set_text(new_synopsis, cx));
        home.update(cx, |h, cx| h.store_synopsis(cx));
    });
    wait(vcx, "re-saved title and synopsis", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && home.read_with(vcx, |h, _| {
                h.loaded
                    .as_ref()
                    .is_some_and(|d| d.title == "潮声北归" && d.summary == new_synopsis)
            })
    });
    vcx.executor().advance_clock(Duration::from_millis(120));
    vcx.run_until_parked();

    // Close library via dr_shell::library::replace and reopen from disk to verify
    // both store persistence and fresh Home UI hydration across restarts.
    drop(title_in);
    drop(synopsis_in);
    drop(home);
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
            move |result, _cx| {
                *replaced_done.borrow_mut() = Some(result);
            },
        );
    });
    wait(vcx, "library reopened from disk", |_| {
        replaced.borrow().is_some()
    });
    assert_eq!(replaced.borrow_mut().take().unwrap(), Ok(()));

    let reopened_home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "reopened home hydrated", |vcx| {
        reopened_home.read_with(vcx, |h, _| {
            h.loaded
                .as_ref()
                .is_some_and(|d| d.title == "潮声北归" && d.summary == new_synopsis)
        })
    });
    assert_eq!(
        reopened_home.read_with(vcx, |h, cx| h.title_input().read(cx).text()),
        "潮声北归"
    );
    assert_eq!(
        reopened_home.read_with(vcx, |h, cx| h.synopsis_input().read(cx).text()),
        new_synopsis
    );
    let persisted = vcx.update(|_, cx| {
        call(
            cx.global::<Services>().library.as_ref().unwrap(),
            "book.get",
            json!({ "book": book }),
        )
    });
    assert_eq!(persisted["name"], "潮声北归");
    assert_eq!(persisted["summary"], new_synopsis);
    vcx.update(|_, cx| cx.global::<Services>().library.as_ref().unwrap().close());
}

#[gpui::test]
fn turning_has_book_off_hides_targets_and_top_counts_and_reopening_restores_targets(
    cx: &mut TestAppContext,
) {
    let (_dir, root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);

    // Initially 成书 is on: both top stats lines and both target inputs are drawn.
    assert!(vcx.debug_bounds("v3-home-words").is_some());
    assert!(vcx.debug_bounds("v3-home-today").is_some());
    assert!(vcx.debug_bounds("v3-home-word-target-input").is_some());
    assert!(vcx.debug_bounds("v3-home-daily-target-input").is_some());

    // Set custom word targets (90,000 / 2,400); typed without grouping, they
    // show grouped once stored.
    let (wt_in, dwt_in) = home.read_with(vcx, |h, _| {
        (
            h.word_target_input().clone(),
            h.daily_word_target_input().clone(),
        )
    });
    vcx.update(|_, cx| {
        wt_in.update(cx, |f, cx| f.set_text("90000", cx));
        home.update(cx, |h, cx| h.store_word_target(cx));
        dwt_in.update(cx, |f, cx| f.set_text("2,400", cx));
        home.update(cx, |h, cx| h.store_daily_word_target(cx));
    });
    wait(vcx, "custom targets saved", |vcx| {
        let p = call(&lib, "project.get", json!({ "book": book }));
        !home.read_with(vcx, |h, _| h.is_saving())
            && p["book"]["word_target"] == 90_000
            && p["book"]["daily_word_target"] == 2_400
    });
    assert_eq!(wt_in.read_with(vcx, |f, _| f.text()), "90,000");
    assert_eq!(dwt_in.read_with(vcx, |f, _| f.text()), "2,400");
    // Not a count: quietly back to the stored one, nothing written.
    vcx.update(|_, cx| {
        wt_in.update(cx, |f, cx| f.set_text("-5", cx));
        home.update(cx, |h, cx| h.store_word_target(cx));
    });
    assert_eq!(wt_in.read_with(vcx, |f, _| f.text()), "90,000");
    assert!(!home.read_with(vcx, |h, _| h.is_saving() || h.failed(Field::WordTarget)));

    // Turn 成书 off: both target rows and both top stats lines disappear.
    vcx.update(|_, cx| home.update(cx, |h, cx| h.set_has_book(false, cx)));
    wait(vcx, "has_book off", |vcx| {
        let p = call(&lib, "project.get", json!({ "book": book }));
        !home.read_with(vcx, |h, _| h.is_saving())
            && !home.read_with(vcx, |h, _| h.has_book())
            && p["book"].is_null()
    });
    assert!(vcx.debug_bounds("v3-home-words").is_none());
    assert!(vcx.debug_bounds("v3-home-today").is_none());
    assert!(vcx.debug_bounds("v3-home-word-target-input").is_none());
    assert!(vcx.debug_bounds("v3-home-daily-target-input").is_none());

    // The project is opened anew (the library from disk): still off, and
    // nothing of this session remembers the targets.
    drop((wt_in, dwt_in, home, lib));
    let home = reopen_library(&ws, vcx, root);
    let lib = library_of(vcx);
    wait(vcx, "reopened, still off", |vcx| {
        !home.read_with(vcx, |h, _| h.has_book()) && vcx.debug_bounds("v3-home-words").is_none()
    });
    assert!(call(&lib, "project.get", json!({ "book": book }))["book"].is_null());

    // Turn 成书 back on: both target rows and top stats reappear with the
    // targets the book kept.
    vcx.update(|_, cx| home.update(cx, |h, cx| h.set_has_book(true, cx)));
    wait(vcx, "has_book restored", |vcx| {
        let p = call(&lib, "project.get", json!({ "book": book }));
        !home.read_with(vcx, |h, _| h.is_saving())
            && home.read_with(vcx, |h, _| h.has_book())
            && !p["book"].is_null()
            && vcx.debug_bounds("v3-home-words").is_some()
    });
    assert!(vcx.debug_bounds("v3-home-today").is_some());
    assert!(vcx.debug_bounds("v3-home-word-target-input").is_some());
    assert!(vcx.debug_bounds("v3-home-daily-target-input").is_some());

    let proj = call(&lib, "project.get", json!({ "book": book }));
    assert_eq!(proj["book"]["word_target"], 90_000);
    assert_eq!(proj["book"]["daily_word_target"], 2_400);
    let (wt_in, dwt_in) = home.read_with(vcx, |h, _| {
        (
            h.word_target_input().clone(),
            h.daily_word_target_input().clone(),
        )
    });
    wait(vcx, "targets shown again", |vcx| {
        wt_in.read_with(vcx, |f, _| f.text()) == "90,000"
            && dwt_in.read_with(vcx, |f, _| f.text()) == "2,400"
    });

    // 1-step undo turns 成书 back off; redo turns it on with 90,000 / 2,400.
    undo(&lib);
    wait(vcx, "undo turning has_book on", |vcx| {
        !home.read_with(vcx, |h, _| h.has_book()) && vcx.debug_bounds("v3-home-words").is_none()
    });
    lib.redo(&Actor::User).unwrap().unwrap();
    wait(vcx, "redo turning has_book on", |vcx| {
        home.read_with(vcx, |h, _| h.has_book()) && vcx.debug_bounds("v3-home-words").is_some()
    });
    let proj_after = call(&lib, "project.get", json!({ "book": book }));
    assert_eq!(proj_after["book"]["word_target"], 90_000);
    assert_eq!(proj_after["book"]["daily_word_target"], 2_400);

    lib.close();
}

#[gpui::test]
fn editing_project_agent_fields_updates_agent_structure_context_and_undoes_one_step_each(
    cx: &mut TestAppContext,
) {
    let (_dir, _root, lib, book) = seed_library();
    let book_id = BookId::parse(&book).unwrap();
    let (_ws, home, vcx) = open_workspace(cx, &lib, &book);

    let initial_agent = StructureContext::for_book(&lib, &book_id, None)
        .unwrap()
        .unwrap()
        .project_agent;
    let init_name = initial_agent
        .as_ref()
        .map(|a| a.name.clone())
        .unwrap_or_default();
    let init_desc = initial_agent
        .as_ref()
        .map(|a| a.description.clone())
        .unwrap_or_default();
    let init_inst = initial_agent
        .as_ref()
        .map(|a| a.instructions.clone())
        .unwrap_or_default();

    let (name_in, desc_in, inst_in) = home.read_with(vcx, |h, _| {
        (
            h.agent_name_input().clone(),
            h.agent_description_input().clone(),
            h.agent_instructions_input().clone(),
        )
    });
    assert_eq!(name_in.read_with(vcx, |f, _| f.text()), init_name);
    assert_eq!(desc_in.read_with(vcx, |f, _| f.text()), init_desc);
    assert_eq!(inst_in.read_with(vcx, |f, _| f.text()), init_inst);

    // Step 1: edit 名字
    vcx.update(|_, cx| {
        name_in.update(cx, |f, cx| f.set_text("叙事审校", cx));
        home.update(cx, |h, cx| h.store_agent(cx));
    });
    wait(vcx, "agent name saved", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && StructureContext::for_book(&lib, &book_id, None)
                .unwrap()
                .unwrap()
                .project_agent
                .as_ref()
                .is_some_and(|a| a.name == "叙事审校")
    });

    // Step 2: edit 说明
    vcx.update(|_, cx| {
        desc_in.update(cx, |f, cx| f.set_text("关注长篇线索与时间锚点", cx));
        home.update(cx, |h, cx| h.store_agent(cx));
    });
    wait(vcx, "agent description saved", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && StructureContext::for_book(&lib, &book_id, None)
                .unwrap()
                .unwrap()
                .project_agent
                .as_ref()
                .is_some_and(|a| a.description == "关注长篇线索与时间锚点")
    });

    // Step 3: edit 注意事项
    vcx.update(|_, cx| {
        inst_in.update(cx, |f, cx| {
            f.set_text("不要替作者续写结尾；保持冷峻口吻。", cx)
        });
        home.update(cx, |h, cx| h.store_agent(cx));
    });
    wait(vcx, "agent instructions saved", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && StructureContext::for_book(&lib, &book_id, None)
                .unwrap()
                .unwrap()
                .project_agent
                .as_ref()
                .is_some_and(|a| a.instructions == "不要替作者续写结尾；保持冷峻口吻。")
    });

    let full = StructureContext::for_book(&lib, &book_id, None)
        .unwrap()
        .unwrap()
        .project_agent
        .unwrap();
    assert_eq!(full.name, "叙事审校");
    assert_eq!(full.description, "关注长篇线索与时间锚点");
    assert_eq!(full.instructions, "不要替作者续写结尾；保持冷峻口吻。");

    // Undo step 3 -> instructions restored to `init_inst`, name & description preserved.
    undo(&lib);
    wait(vcx, "undo agent instructions", |vcx| {
        inst_in.read_with(vcx, |f, _| f.text()) == init_inst
    });
    let after_u1 = StructureContext::for_book(&lib, &book_id, None)
        .unwrap()
        .unwrap()
        .project_agent
        .unwrap();
    assert_eq!(after_u1.name, "叙事审校");
    assert_eq!(after_u1.description, "关注长篇线索与时间锚点");
    assert_eq!(after_u1.instructions, init_inst);

    // Undo step 2 -> description restored to `init_desc`, name preserved.
    undo(&lib);
    wait(vcx, "undo agent description", |vcx| {
        desc_in.read_with(vcx, |f, _| f.text()) == init_desc
    });
    let after_u2 = StructureContext::for_book(&lib, &book_id, None)
        .unwrap()
        .unwrap()
        .project_agent
        .unwrap();
    assert_eq!(after_u2.name, "叙事审校");
    assert_eq!(after_u2.description, init_desc);
    assert_eq!(after_u2.instructions, init_inst);

    // Undo step 1 -> entire project_agent returns to `initial_agent`.
    undo(&lib);
    wait(vcx, "undo agent name", |vcx| {
        name_in.read_with(vcx, |f, _| f.text()) == init_name
    });
    assert_eq!(
        StructureContext::for_book(&lib, &book_id, None)
            .unwrap()
            .unwrap()
            .project_agent,
        initial_agent
    );

    lib.close();
}

#[gpui::test]
fn template_source_row_renders_name_optional_single_author_and_never_derived_from(
    cx: &mut TestAppContext,
) {
    let (_dir, _root, lib, base_book) = seed_library();

    // Project created from the built-in writing project template (`写书`, no credit).
    let builtin_book = call(&lib, "project.create", json!({ "name": "未命名" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Save template 1 (by 甲), create an intermediate project from it, then save
    // template 2 ("长篇连载", by 林舟) from the intermediate project and create a
    // final project from template 2. Only "林舟" may appear — never "甲" or "改自".
    let tpl1 = call(
        &lib,
        "project_template.save",
        json!({
            "book": builtin_book,
            "name": "初版底稿",
            "credit": { "author": "甲" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mid_book = call(
        &lib,
        "project.create",
        json!({
            "name": "中间项目",
            "template_id": tpl1
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tpl2 = call(
        &lib,
        "project_template.save",
        json!({
            "book": mid_book,
            "name": "长篇连载",
            "credit": { "author": "林舟" }
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let credited_book = call(
        &lib,
        "project.create",
        json!({
            "name": "北港夜航",
            "template_id": tpl2
        }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (ws, home, vcx) = open_workspace(cx, &lib, &base_book);

    // 1. A seeded book names the built-in template it was laid out from, as a
    //    new project does (the PT4 follow-up, 2026-11-16, records the name for
    //    seeds, sample books and 0.1 imports), so 「来源」 shows it; a raw id
    //    never shows.
    wait(vcx, "seeded book shows its source", |vcx| {
        vcx.debug_bounds("v3-home-template-source").is_some()
    });
    assert_eq!(
        home.read_with(vcx, |h, cx| h.template_source_text(cx))
            .as_deref(),
        Some("来自「写书」")
    );

    // 2. Project created from built-in template shows "来自「写书」" with no author, plus
    //    `focus_project_title` focuses the inline title input when PT3 opens a new project.
    vcx.update(|window, cx| {
        focus_project_title(&builtin_book, cx);
        ws.update(cx, |ws, cx| ws.open_book(&builtin_book, window, cx));
    });
    wait(vcx, "builtin book opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == builtin_book)
            && vcx.debug_bounds("v3-home-template-source").is_some()
    });
    assert!(vcx.debug_bounds("v3-home-template-source-author").is_none());
    let builtin_src = home
        .read_with(vcx, |h, cx| h.template_source_text(cx))
        .expect("builtin source text");
    assert_eq!(builtin_src, "来自「写书」");
    assert!(!builtin_src.contains("改自"));
    let title_focused = vcx.update(|window, cx| {
        home.read(cx)
            .title_input()
            .read(cx)
            .focus_handle(cx)
            .is_focused(window)
    });
    assert!(
        title_focused,
        "focus_project_title should focus the inline title"
    );

    // 3. Switch Workspace to `credited_book`: shows template name + single author, never 改自.
    vcx.update(|window, cx| ws.update(cx, |ws, cx| ws.open_book(&credited_book, window, cx)));
    wait(vcx, "credited book opened on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == credited_book)
            && vcx.debug_bounds("v3-home-template-source-author").is_some()
    });
    let credited_src = home
        .read_with(vcx, |h, cx| h.template_source_text(cx))
        .expect("credited source text");
    assert_eq!(credited_src, "来自「长篇连载」 林舟");
    assert!(!credited_src.contains("改自"));
    assert!(!credited_src.contains("甲"));

    lib.close();
}

#[gpui::test]
fn save_project_template_button_follows_registration_and_dispatches_active_book(
    cx: &mut TestAppContext,
) {
    let (_dir, _root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);

    // `dr_view_home::init` registers PT3's Save-as dialog by default -> button is drawn
    // and clicking it opens the Save-as modal over the workspace.
    assert!(vcx.update(|_, cx| has_save_project_template(cx)));
    wait(vcx, "save project template button drawn by init", |vcx| {
        vcx.debug_bounds("v3-home-save-project-template").is_some()
    });
    let btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button bounds");
    vcx.simulate_click(btn.center(), Modifiers::none());
    wait(vcx, "save project template dialog opened", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_some())
            && vcx.debug_bounds("v3-save-tpl-rail-summary").is_some()
    });

    let window_height = px(640.0);
    vcx.simulate_resize(size(px(1280.0), window_height));
    vcx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let submit = vcx
        .debug_bounds("v3-save-tpl-submit")
        .expect("new template button");
    assert!(
        submit.origin.y >= px(0.0) && submit.origin.y + submit.size.height <= window_height,
        "the new template button must stay fully visible when the window is short"
    );

    vcx.simulate_resize(size(px(1280.0), px(960.0)));
    vcx.simulate_keystrokes("escape");
    wait(vcx, "save project template dialog closed", |vcx| {
        ws.read_with(vcx, |ws, _| ws.dialog.is_none())
    });

    // Clearing registration hides the button.
    vcx.update(|_, cx| {
        clear_save_project_template(cx);
        home.update(cx, |_, cx| cx.notify());
    });
    assert!(!vcx.update(|_, cx| has_save_project_template(cx)));
    wait(
        vcx,
        "save project template button hidden when cleared",
        |vcx| vcx.debug_bounds("v3-home-save-project-template").is_none(),
    );

    // Registering a custom handler shows the button again and dispatches the active book.
    let invocations: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let recorded = invocations.clone();
    vcx.update(|_, cx| {
        set_save_project_template(cx, move |host: SaveProjectTemplateHost, _, _| {
            // Weak handles: the library is there while it is open.
            assert!(host.library.upgrade().is_some());
            assert!(host.workspace.upgrade().is_some());
            recorded.borrow_mut().push(host.book_id);
        });
        home.update(cx, |_, cx| cx.notify());
    });
    assert!(vcx.update(|_, cx| has_save_project_template(cx)));
    wait(vcx, "save project template button drawn again", |vcx| {
        vcx.debug_bounds("v3-home-save-project-template").is_some()
    });

    let btn = vcx
        .debug_bounds("v3-home-save-project-template")
        .expect("save button bounds");
    vcx.simulate_click(btn.center(), Modifiers::none());
    vcx.run_until_parked();
    assert_eq!(*invocations.borrow(), vec![book]);

    // Clearing registration hides the button again.
    vcx.update(|_, cx| {
        clear_save_project_template(cx);
        home.update(cx, |_, cx| cx.notify());
    });
    wait(vcx, "save project template button hidden again", |vcx| {
        vcx.debug_bounds("v3-home-save-project-template").is_none()
    });

    lib.close();
}

#[test]
fn retired_settings_dialog_and_locale_keys_are_gone() {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(
        !crate_dir.join("src/v3_settings.rs").exists(),
        "v3_settings.rs must be deleted"
    );
    let keys_txt =
        std::fs::read_to_string(crate_dir.join("../dr-i18n/keys.txt")).expect("read keys.txt");
    let own_zh = std::fs::read_to_string(crate_dir.join("../dr-i18n/own/zh-CN.json"))
        .expect("read own/zh-CN.json");
    for retired in [
        "projectHome.views.settings",
        "dashboard.hero.projectName",
        "dashboard.sections.projectProfile",
    ] {
        assert!(
            !keys_txt.lines().any(|l| l.trim() == retired),
            "retired locale key {retired} must be removed from keys.txt"
        );
        assert!(
            !own_zh.contains(retired),
            "retired locale key {retired} must not appear in own/zh-CN.json"
        );
    }
    let own_val: Value = serde_json::from_str(&own_zh).expect("valid own/zh-CN.json");
    let pt_block = &own_val["projectHome"]["projectTemplate"];
    for leaf in ["fromTemplate", "saveAs", "source", "title"] {
        assert!(
            pt_block[leaf].as_str().is_some_and(|s| !s.is_empty()),
            "expected locale key projectHome.projectTemplate.{leaf} in own/zh-CN.json"
        );
    }
}

/// Reopens the library from disk (`dr_shell::library::replace`) and returns
/// the Project Home the workspace makes afresh.
fn reopen_library(
    ws: &Entity<Workspace>,
    vcx: &mut VisualTestContext,
    root: std::path::PathBuf,
) -> Entity<Home> {
    // Let Home's last read of the numbers finish first.
    vcx.executor().advance_clock(Duration::from_millis(120));
    vcx.run_until_parked();
    let replaced = Rc::new(RefCell::new(None));
    let replaced_done = replaced.clone();
    vcx.update(|_, cx| {
        dr_shell::library::replace(
            cx,
            move |opened_root, options| {
                assert_eq!(opened_root, root);
                dr_store::Library::open(opened_root, options).map_err(|e| e.to_string())
            },
            move |result, _cx| {
                *replaced_done.borrow_mut() = Some(result);
            },
        );
    });
    wait(vcx, "library reopened from disk", |_| {
        replaced.borrow().is_some()
    });
    assert_eq!(replaced.borrow_mut().take().unwrap(), Ok(()));
    let home: Entity<Home> = ws.read_with(vcx, |ws, _| {
        ws.v3_home.clone().unwrap().downcast::<Home>().unwrap()
    });
    wait(vcx, "reopened home hydrated", |vcx| {
        home.read_with(vcx, |h, _| h.loaded.is_some())
    });
    home
}

fn library_of(vcx: &mut VisualTestContext) -> Library {
    vcx.update(|_, cx| cx.global::<Services>().library.clone().unwrap())
}

/// Enter in the title stores the name and goes on to the synopsis, as an
/// entry's title goes on to its text (作者 2026-11-16 四乙).
#[gpui::test]
fn enter_in_the_title_stores_it_and_moves_to_the_synopsis(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);
    let (title_in, synopsis_in) = home.read_with(vcx, |h, _| {
        (h.title_input().clone(), h.synopsis_input().clone())
    });
    vcx.update(|window, cx| {
        window.focus(&title_in.focus_handle(cx), cx);
        title_in.update(cx, |f, cx| f.set_text("回车改名", cx));
    });
    vcx.simulate_keystrokes("enter");
    wait(vcx, "name stored after Enter", |vcx| {
        !home.read_with(vcx, |h, _| h.is_saving())
            && ws.read_with(vcx, |ws, _| ws.book.name == "回车改名")
    });
    let (title_focused, synopsis_focused) = vcx.update(|window, cx| {
        (
            title_in.focus_handle(cx).is_focused(window),
            synopsis_in.focus_handle(cx).is_focused(window),
        )
    });
    assert!(!title_focused);
    assert!(synopsis_focused, "Enter hands the caret to the synopsis");
    assert_eq!(
        call(&lib, "book.get", json!({"book": book}))["name"],
        "回车改名"
    );
    lib.close();
}

/// A write refused because the name changed elsewhere keeps what was typed,
/// with 「未能保存」 and 「重试」; 「重试」 stores it over the name stored now.
#[gpui::test]
fn a_refused_title_keeps_the_draft_and_retry_stores_it(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);
    let title_in = home.read_with(vcx, |h, _| h.title_input().clone());
    // The author is typing; meanwhile the name is changed elsewhere.
    vcx.update(|_, cx| title_in.update(cx, |f, cx| f.set_text("作者打的名字", cx)));
    call(
        &lib,
        "book.update",
        json!({"book": book, "name": "别处改的名字"}),
    );
    wait(vcx, "the shell read the other name", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.name == "别处改的名字")
    });
    assert_eq!(
        title_in.read_with(vcx, |f, _| f.text()),
        "作者打的名字",
        "a field being edited is not replaced"
    );
    vcx.update(|_, cx| home.update(cx, |h, cx| h.store_title(cx)));
    wait(vcx, "refused", |vcx| {
        home.read_with(vcx, |h, _| !h.is_saving() && h.failed(Field::Title))
    });
    assert_eq!(title_in.read_with(vcx, |f, _| f.text()), "作者打的名字");
    assert_eq!(
        call(&lib, "book.get", json!({"book": book}))["name"],
        "别处改的名字"
    );
    assert!(vcx.debug_bounds("v3-home-failed-title").is_some());
    // Leaving the field again does not retry on its own.
    vcx.update(|_, cx| home.update(cx, |h, cx| h.store_title(cx)));
    assert!(home.read_with(vcx, |h, _| h.failed(Field::Title)));

    let retry = vcx
        .debug_bounds("v3-home-retry-title")
        .expect("「重试」 is drawn");
    vcx.simulate_click(retry.center(), Modifiers::none());
    wait(vcx, "retried", |vcx| {
        home.read_with(vcx, |h, _| !h.is_saving() && !h.failed(Field::Title))
            && ws.read_with(vcx, |ws, _| ws.book.name == "作者打的名字")
    });
    assert!(vcx.debug_bounds("v3-home-failed-title").is_none());
    lib.close();
}

/// A name being typed when the library is let go of (a swap, quitting) is
/// stored first: the shell blurs the field, then waits for Home to store it.
#[gpui::test]
fn a_title_being_typed_is_stored_before_the_library_is_let_go_of(cx: &mut TestAppContext) {
    let (_dir, root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);
    let title_in = home.read_with(vcx, |h, _| h.title_input().clone());
    vcx.update(|window, cx| {
        window.focus(&title_in.focus_handle(cx), cx);
        title_in.update(cx, |f, cx| f.set_text("换库前打的名字", cx));
    });
    drop(title_in);
    drop(home);
    drop(lib);
    let reopened = reopen_library(&ws, vcx, root);
    assert_eq!(
        reopened.read_with(vcx, |h, cx| h.title_input().read(cx).text()),
        "换库前打的名字"
    );
    let lib = library_of(vcx);
    assert_eq!(
        call(&lib, "book.get", json!({"book": book}))["name"],
        "换库前打的名字"
    );
    lib.close();
}

/// A request to select the title of the book Home already shows is taken
/// on the next frame, not left pending until the book changes.
#[gpui::test]
fn focusing_the_title_of_the_book_shown_is_not_left_pending(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);
    let title_in = home.read_with(vcx, |h, _| h.title_input().clone());
    vcx.update(|window, cx| {
        let focus = ws.read(cx).focus_handle().clone();
        window.focus(&focus, cx);
        focus_project_title(&book, cx);
    });
    wait(vcx, "title focused", |vcx| {
        vcx.update(|window, cx| title_in.focus_handle(cx).is_focused(window))
    });
    // Taken: a change of the book later does not take the caret again.
    vcx.update(|window, cx| {
        let focus = ws.read(cx).focus_handle().clone();
        window.focus(&focus, cx);
    });
    call(
        &lib,
        "book.update",
        json!({"book": book, "summary": "换一个简介"}),
    );
    wait(vcx, "the book changed", |vcx| {
        home.read_with(vcx, |h, _| {
            h.loaded.as_ref().is_some_and(|d| d.summary == "换一个简介")
        })
    });
    assert!(!vcx.update(|window, cx| title_in.focus_handle(cx).is_focused(window)));
    lib.close();
}

/// In a template's working copy (编辑模板的工作区) Home draws no source row,
/// no 「另存为项目模板」 and no word lines at the top.
#[gpui::test]
fn a_templates_working_copy_hides_source_save_and_word_lines(cx: &mut TestAppContext) {
    let (_dir, _root, lib, book) = seed_library();
    let template = call(
        &lib,
        "project_template.save",
        json!({"book": book, "name": "合成模板"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let copy = call(&lib, "project_template.edit", json!({"id": template}))["book"]
        .as_str()
        .unwrap()
        .to_owned();
    let (ws, home, vcx) = open_workspace(cx, &lib, &book);
    vcx.update(|_, cx| {
        set_save_project_template(cx, |_, _, _| {});
        home.update(cx, |_, cx| cx.notify());
    });
    wait(vcx, "the button for an ordinary project", |vcx| {
        vcx.debug_bounds("v3-home-save-project-template").is_some()
    });
    assert!(!home.read_with(vcx, |h, _| h.template_workspace()));
    vcx.update(|window, cx| ws.update(cx, |ws, cx| ws.open_book(&copy, window, cx)));
    wait(vcx, "the working copy on Home", |vcx| {
        ws.read_with(vcx, |ws, _| ws.book.id == copy)
            && home.read_with(vcx, |h, _| h.template_workspace() && h.loaded.is_some())
    });
    assert!(vcx.debug_bounds("v3-home-project-template").is_some());
    assert!(vcx.debug_bounds("v3-home-save-project-template").is_none());
    assert!(vcx.debug_bounds("v3-home-template-source").is_none());
    assert!(vcx.debug_bounds("v3-home-words").is_none());
    assert!(vcx.debug_bounds("v3-home-today").is_none());
    vcx.update(|_, cx| clear_save_project_template(cx));
    lib.close();
}
