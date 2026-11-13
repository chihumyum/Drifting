//! K4-G1: synthetic v3 module lifetime, undo isolation and chapter chrome.
use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
use dr_view_page::v3::BodyModule;
use dr_workspace::{Actor, Workspace};
use gpui::{Entity, EntityInputHandler, TestAppContext, VisualTestContext, WeakEntity, px, size};
use serde_json::{Value, json};
use std::{
    rc::Rc,
    time::{Duration, Instant},
};
struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
}
fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let store = dr_store::Library::open(dir.path(), dr_workspace::library_options("test")).unwrap();
    let seed = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = seed.books[0].book_id().to_string();
    seed.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "test").unwrap();
    let entries = call(&ws, "entry.list", json!({"book": book, "all": true}));
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
        entry,
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}
fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "module timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn open(cx: &mut TestAppContext, e: &Env, module: &str) -> (Entity<BodyModule>, VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let module = book
        .v3()
        .unwrap()
        .template_of(&e.entry)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == module)
        .unwrap()
        .clone();
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: e.ws.clone(),
            book_id: e.book.clone(),
            book,
        },
        entry: e.entry.clone(),
        module,
    };
    let window = cx.add_window(|window, cx| BodyModule::new(host, window, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.), px(900.)));
    vcx.update(|window, cx| {
        use gpui::Focusable as _;
        view.focus_handle(cx).focus(window, cx);
    });
    wait(&mut vcx, |cx| {
        view.read_with(cx, |v, _| v.editor().is_some())
    });
    (view, vcx)
}
#[gpui::test]
fn refresh_keeps_editors_and_undo_separate(cx: &mut TestAppContext) {
    let e = env();
    call(
        &e.ws,
        "entry_template.put_module",
        json!({"book":e.book,"template":"tpl-chapter","module":{"id":"second-prose","kind":"prose","name":"Second"}}),
    );
    let (first, mut a) = open(cx, &e, "mod-prose");
    let (second, mut b) = open(&mut a.cx.clone(), &e, "second-prose");
    let first_ed = first.read_with(&a, |v, _| v.editor().unwrap());
    let second_ed = second.read_with(&b, |v, _| v.editor().unwrap());
    let pa = first_ed.read_with(&a, |v, _| v.editor().clone());
    let pb = second_ed.read_with(&b, |v, _| v.editor().clone());
    let before_a = first_ed.read_with(&a, |v, cx| v.plain_text(cx));
    let before_b = second_ed.read_with(&b, |v, cx| v.plain_text(cx));
    pa.update_in(&mut a, |p, window, cx| {
        p.select(0, 0..0, window, cx);
        p.replace_text_in_range(None, "A", window, cx);
    });
    pb.update_in(&mut b, |p, window, cx| {
        p.select(0, 0..0, window, cx);
        p.replace_text_in_range(None, "B", window, cx);
    });
    call(
        &e.ws,
        "entry.update",
        json!({"book": e.book,"id": e.entry,"title":"Refreshed"}),
    );
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    first.update(&mut a, |v, cx| v.refresh(book.clone(), cx));
    second.update(&mut b, |v, cx| v.refresh(book, cx));
    draw(&mut a);
    draw(&mut b);
    assert_eq!(
        first.read_with(&a, |v, _| v.editor().unwrap().entity_id()),
        first_ed.entity_id()
    );
    assert_eq!(
        second.read_with(&b, |v, _| v.editor().unwrap().entity_id()),
        second_ed.entity_id()
    );
    pa.update_in(&mut a, |p, window, cx| p.undo(window, cx));
    assert_eq!(first_ed.read_with(&a, |v, cx| v.plain_text(cx)), before_a);
    assert_eq!(
        second_ed.read_with(&b, |v, cx| v.plain_text(cx)),
        format!("B{before_b}")
    );
    pb.update_in(&mut b, |p, window, cx| p.undo(window, cx));
    assert_eq!(second_ed.read_with(&b, |v, cx| v.plain_text(cx)), before_b);
}
#[gpui::test]
fn chrome_reads_and_writes_v3_roles(cx: &mut TestAppContext) {
    let e = env();
    let (view, mut vcx) = open(cx, &e, "mod-prose");
    let doc = format!("body:{}/mod-prose", e.entry);
    let editor = view.read_with(&vcx, |v, _| v.editor().unwrap());
    wait(&mut vcx, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&doc, cx).is_some())
    });
    let page = editor.read_with(&vcx, |v, _| v.page_info().unwrap());
    assert_eq!(page.kind, dr_editor::page::PageKind::Chapter);
    assert!(page.number.is_some());
    assert!(page.storyline.is_some());
    assert!(dr_editor::page::set_synopsis(&e.ws, &e.book, &doc, "G1").unwrap());
    dr_editor::page::set_finished(&e.ws, &e.book, &doc, true).unwrap();
    assert_eq!(
        dr_editor::page::rename(&e.ws, &e.book, &doc, "  Title  ").unwrap(),
        Some("Title".into())
    );
    wait(&mut vcx, |cx| {
        editor.read_with(cx, |v, _| {
            v.page_info()
                .is_some_and(|p| p.title == "Title" && p.synopsis == "G1" && p.finished())
        })
    });
    let entry = call(&e.ws, "entry.get", json!({"book":e.book,"id":e.entry}));
    assert_eq!(entry["fields"]["mod-fields"]["summary"], "G1");
    assert_eq!(entry["fields"]["mod-fields"]["status"], "finished");
    assert_eq!(entry["title"], "Title");
}

#[gpui::test]
fn seeded_comment_sand_uses_its_body_module_only(cx: &mut TestAppContext) {
    let mut e = env();
    let comment = dr_editor::v3::read(&e.ws, &e.book, |v| {
        v.comments().into_iter().find(|c| {
            c.anchor.is_some()
                && c.target_module.is_some()
                && c.status == dr_model::kind::CommentStatus::Open
                && c.target
                    .as_ref()
                    .is_some_and(|t| t.kind == dr_model::kind::EntityKind::Entry)
        })
    })
    .unwrap()
    .expect("shared tiny seed has an anchored v3 comment");
    e.entry = comment.target.unwrap().id;
    let module = comment.target_module.unwrap().to_string();
    let (view, mut vcx) = open(cx, &e, &module);
    let editor = view.read_with(&vcx, |v, cx| v.editor().unwrap().read(cx).editor().clone());
    let id = comment.id.to_string();
    wait(&mut vcx, |cx| {
        editor.read_with(cx, |p, _| p.decoration_range(0, "comments", &id).is_some())
    });
    let before = editor.read_with(&vcx, |p, _| p.decoration_range(0, "comments", &id).unwrap());
    editor.update_in(&mut vcx, |p, window, cx| {
        p.select(0, 0..0, window, cx);
        p.replace_text_in_range(None, "A", window, cx);
    });
    draw(&mut vcx);
    assert_eq!(
        editor.read_with(&vcx, |p, _| p.decoration_range(0, "comments", &id)),
        Some(before.start + 1..before.end + 1)
    );
    let anchors = dr_editor::anchors::book_comment_anchors(&e.ws, &e.book).unwrap();
    let doc = format!("body:{}/{}", e.entry, module);
    assert!(anchors.get(&doc).unwrap().iter().any(|(i, _)| i == &id));
    assert!(
        !anchors
            .iter()
            .any(|(d, xs)| d != &doc && xs.iter().any(|(i, _)| i == &id))
    );
}

#[gpui::test]
fn body_keeps_slash_menu_and_selection_bar(cx: &mut TestAppContext) {
    let e = env();
    let (view, mut vcx) = open(cx, &e, "mod-prose");
    let editor = view.read_with(&vcx, |v, _| v.editor().unwrap());
    let prose = editor.read_with(&vcx, |e, _| e.editor().clone());
    let assist = editor.read_with(&vcx, |e, _| e.assist().clone());
    prose.update_in(&mut vcx, |p, window, cx| {
        gpui::Focusable::focus_handle(p, cx).focus(window, cx);
        p.select(0, 0..0, window, cx);
        p.replace_text_in_range(None, "/", window, cx);
    });
    draw(&mut vcx);
    assert!(assist.read_with(&vcx, |a, _| a.menu().is_some()));
    assist.update_in(&mut vcx, |a, window, cx| a.choose(Some(2), window, cx));
    assert_eq!(
        prose.read_with(&vcx, |p, _| p.book().chapters[0]
            .doc
            .line(0)
            .block
            .heading()),
        Some(2)
    );
    prose.update_in(&mut vcx, |p, window, cx| p.select(0, 0..2, window, cx));
    draw(&mut vcx);
    vcx.executor()
        .advance_clock(dr_editor::assist::BAR_DELAY + Duration::from_millis(20));
    draw(&mut vcx);
    assert!(assist.read_with(&vcx, |a, _| a.bar().is_some()));
}

#[gpui::test]
fn newly_created_body_keeps_title_focus_across_async_load(cx: &mut TestAppContext) {
    use gpui::Focusable as _;
    let e = env();
    let doc = format!("body:{}/mod-prose", e.entry);
    cx.update(|cx| dr_view_page::focus_new_title(doc.clone(), cx));
    let (view, mut vcx) = open(cx, &e, "mod-prose");
    wait(&mut vcx, |cx| {
        cx.update(|window, cx| {
            dr_view_page::page_views(&doc, cx)
                .is_some_and(|(head, _)| head.read(cx).title().focus_handle(cx).is_focused(window))
        })
    });
    let editor = view.read_with(&vcx, |v, _| v.editor().unwrap());
    assert!(!vcx.update(|window, cx| editor.read(cx).editor().focus_handle(cx).is_focused(window)));
}

fn head_release_case(cx: &mut TestAppContext, summary: bool, conflict: bool) {
    use gpui::Focusable as _;
    use std::cell::{Cell, RefCell};
    let e = env();
    let (_body, mut cx) = open(cx, &e, "mod-prose");
    let doc = format!("body:{}/mod-prose", e.entry);
    wait(&mut cx, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&doc, cx).is_some())
    });
    let head = cx.update(|_, cx| dr_view_page::page_views(&doc, cx).unwrap().0);
    let input = head.read_with(&cx, |h, _| {
        if summary {
            h.synopsis().clone()
        } else {
            h.title().clone()
        }
    });
    cx.update(|_, cx| cx.global_mut::<Services>().library = Some(e.ws.clone()));
    input.update_in(&mut cx, |a, w, cx| {
        a.focus_handle(cx).focus(w, cx);
        a.select_all_text(cx);
        a.replace_text_in_range(None, "accepted head draft", w, cx);
    });
    draw(&mut cx);
    if conflict {
        if summary {
            call(
                &e.ws,
                "module.set_field",
                json!({"book":e.book,"entry":e.entry,"module":"mod-fields","field":"summary","value":"external metadata"}),
            );
        } else {
            call(
                &e.ws,
                "entry.update",
                json!({"book":e.book,"id":e.entry,"title":"external metadata"}),
            );
        }
        let result = Rc::new(RefCell::new(None));
        let seen = result.clone();
        cx.update(|_, cx| {
            dr_shell::library::replace(
                cx,
                |_, _| unreachable!("conflicting head must block replacement"),
                move |r, _| *seen.borrow_mut() = Some(r),
            )
        });
        let until = Instant::now() + Duration::from_secs(15);
        while result.borrow().is_none() {
            cx.executor().advance_clock(Duration::from_millis(10));
            draw(&mut cx);
            assert!(Instant::now() < until);
        }
        assert!(result.borrow().as_ref().unwrap().is_err());
        input.update_in(&mut cx, |a, w, cx| a.focus_handle(cx).focus(w, cx));
        cx.simulate_keystrokes("escape");
        draw(&mut cx);
        assert_eq!(input.read_with(&cx, |a, _| a.text()), "accepted head draft");
        let metadata = call(&e.ws, "entry.get", json!({"book":e.book,"id":e.entry}));
        assert_eq!(
            if summary {
                &metadata["fields"]["mod-fields"]["summary"]
            } else {
                &metadata["title"]
            },
            "external metadata"
        );
        cx.update(|_, cx| assert!(!dr_shell::release::is_releasing(cx)));
    } else {
        let quit = Rc::new(Cell::new(false));
        let seen = quit.clone();
        cx.update(|_, cx| {
            dr_shell::quit::before_quit(cx, move |_| seen.set(true));
            dr_shell::quit::request(cx);
        });
        let until = Instant::now() + Duration::from_secs(15);
        while !quit.get() {
            cx.executor().advance_clock(Duration::from_millis(10));
            draw(&mut cx);
            assert!(Instant::now() < until);
        }
        let metadata = call(&e.ws, "entry.get", json!({"book":e.book,"id":e.entry}));
        assert_eq!(
            if summary {
                &metadata["fields"]["mod-fields"]["summary"]
            } else {
                &metadata["title"]
            },
            "accepted head draft"
        );
    }
    e.ws.close();
}
#[gpui::test]
fn title_head_flushes_focused_input_before_quit(cx: &mut TestAppContext) {
    head_release_case(cx, false, false)
}
#[gpui::test]
fn synopsis_head_flushes_focused_input_before_quit(cx: &mut TestAppContext) {
    head_release_case(cx, true, false)
}
#[gpui::test]
fn title_head_conflict_keeps_input_and_blocks_replacement(cx: &mut TestAppContext) {
    head_release_case(cx, false, true)
}
#[gpui::test]
fn synopsis_head_conflict_keeps_input_and_blocks_replacement(cx: &mut TestAppContext) {
    head_release_case(cx, true, true)
}

#[gpui::test]
fn cancelling_after_save_never_rewrites_old_page_facts(cx: &mut TestAppContext) {
    use gpui::Focusable as _;
    let e = env();
    let (body, mut cx) = open(cx, &e, "mod-prose");
    let doc = format!("body:{}/mod-prose", e.entry);
    wait(&mut cx, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&doc, cx).is_some())
    });
    let head = cx.update(|_, cx| dr_view_page::page_views(&doc, cx).unwrap().0);
    let editor = body.read_with(&cx, |b, _| b.editor().unwrap());
    let old = editor.read_with(&cx, |e, _| e.page_info().unwrap());
    let input = head.read_with(&cx, |h, _| h.title().clone());
    input.update_in(&mut cx, |a, w, cx| {
        a.focus_handle(cx).focus(w, cx);
        a.select_all_text(cx);
        a.replace_text_in_range(None, "acknowledged title", w, cx);
    });
    cx.update(|w, cx| w.blur(cx));
    wait(&mut cx, |_| {
        call(&e.ws, "entry.get", json!({"book":e.book,"id":e.entry}))["title"]
            == "acknowledged title"
    });
    draw(&mut cx);
    head.update_in(&mut cx, |h, w, cx| h.set_page(&old, w, cx));
    input.update_in(&mut cx, |a, w, cx| a.focus_handle(cx).focus(w, cx));
    let displayed = input.read_with(&cx, |a, _| a.text());
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    assert_eq!(input.read_with(&cx, |a, _| a.text()), displayed);
    assert_eq!(
        call(&e.ws, "entry.get", json!({"book":e.book,"id":e.entry}))["title"],
        "acknowledged title"
    );
    e.ws.close();
}

#[gpui::test]
fn body_module_expands_flat_beyond_720px_without_inner_clamp(cx: &mut TestAppContext) {
    use gpui::{
        AppContext as _, InteractiveElement as _, IntoElement, ParentElement as _, Render,
        StatefulInteractiveElement as _, Styled as _,
    };

    struct ScrollHost {
        body: Entity<BodyModule>,
    }
    impl Render for ScrollHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            gpui::div()
                .id("entry-scroll")
                .size_full()
                .overflow_y_scroll()
                .child(self.body.clone())
        }
    }

    let e = env();
    let paragraphs: Vec<Value> = (1..=60)
        .map(|i| {
            json!({
                "text": format!(
                    "第 {i} 段正文，在条目页里应当自然摊平展开，而不是被限制在固定高度的小滚动框里。"
                )
            })
        })
        .collect();
    call(
        &e.ws,
        "module.set_prose",
        json!({
            "book": e.book,
            "owner": e.entry,
            "module": "mod-prose",
            "paragraphs": paragraphs,
        }),
    );
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "test",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(dr_ui::Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
        }
    });
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let module = book
        .v3()
        .unwrap()
        .template_of(&e.entry)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == "mod-prose")
        .unwrap()
        .clone();
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: e.ws.clone(),
            book_id: e.book.clone(),
            book,
        },
        entry: e.entry.clone(),
        module,
    };
    let window = cx.add_window(|window, cx| ScrollHost {
        body: cx.new(|cx| BodyModule::new(host, window, cx)),
    });
    let body = window
        .root(cx)
        .unwrap()
        .read_with(cx, |h, _| h.body.clone());
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.simulate_resize(size(px(1000.), px(900.)));
    wait(&mut vcx, |cx| {
        body.read_with(cx, |v, _| v.editor().is_some())
    });
    let doc = format!("body:{}/mod-prose", e.entry);
    wait(&mut vcx, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&doc, cx).is_some())
    });
    draw(&mut vcx);
    draw(&mut vcx);
    let selector: &'static str =
        Box::leak(format!("v3-body-{}-mod-prose", e.entry).into_boxed_str());
    let bounds = vcx.debug_bounds(selector).expect("flat body module bounds");
    assert!(
        bounds.size.height > px(1500.0),
        "expected BodyModule to expand flat past viewport (900px) and old 720px clamp, got {:?}",
        bounds.size
    );
    e.ws.close();
}

#[gpui::test]
fn custom_template_folio_chrome_color_and_secondary_prose(cx: &mut TestAppContext) {
    use dr_editor::page::PageKind;

    let mut e = env();
    call(
        &e.ws,
        "entry_template.put",
        json!({
            "book": e.book,
            "template": {
                "id": "custom-interlude",
                "name": "幕间",
                "level": false,
                "modules": [
                    {"id": "mod-prose", "kind": "prose", "name": "正文", "pos": "a0", "config": {"in_book": true}},
                    {"id": "mod-notes", "kind": "prose", "name": "附记", "pos": "a1", "config": {"in_book": true}},
                    {"id": "mod-description", "kind": "prose", "name": "说明", "pos": "a2", "config": {"in_book": false}},
                    {
                        "id": "mod-fields",
                        "kind": "fields",
                        "name": "属性",
                        "pos": "a3",
                        "config": {
                            "defs": [
                                {"id": "tint", "name": "颜色", "field_type": "text", "pos": "a0"}
                            ],
                            "color_field": "tint"
                        }
                    }
                ]
            }
        }),
    );

    let initial = Book::load(&e.ws, &e.book).unwrap();
    let v0 = initial.v3().unwrap();
    let ms_root = v0
        .entries
        .iter()
        .find(|x| x.template.as_deref() == Some("tpl-manuscript"))
        .unwrap()
        .id
        .clone();
    let ideas_root = v0
        .entries
        .iter()
        .find(|x| x.template.as_deref() == Some("tpl-ideas"))
        .unwrap()
        .id
        .clone();
    let lane_host = v0
        .entries
        .iter()
        .find(|x| v0.is_lane(&x.id))
        .unwrap()
        .id
        .clone();
    call(
        &e.ws,
        "module.set_field",
        json!({"book": e.book, "entry": lane_host, "module": "mod-fields", "field": "color", "value": "#2a6f97"}),
    );

    // 1. Custom non-built-in template inside manuscript gets Chapter folio, ordinal, and same-template Next sibling.
    let ms_custom = call(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "parent": ms_root, "template": "custom-interlude", "title": "幕间一"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    e.entry = ms_custom.clone();

    let (primary_view, mut vcx1) = open(cx, &e, "mod-prose");
    let primary_doc = format!("body:{ms_custom}/mod-prose");
    wait(&mut vcx1, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&primary_doc, cx).is_some())
    });
    let info = primary_view
        .read_with(&vcx1, |v, _| v.editor().unwrap())
        .read_with(&vcx1, |v, _| v.page_info().unwrap());
    assert_eq!(info.kind, PageKind::Chapter);
    assert!(info.chrome);
    assert!(info.number.is_some());
    assert_eq!(info.template_name, "幕间");
    assert!(!info.has_synopsis);
    assert!(!info.has_status);

    let next_doc =
        dr_editor::page::new_chapter_after(&e.ws, &e.book, &primary_doc, "下一节").unwrap();
    let next_id = next_doc
        .strip_prefix("body:")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    assert_eq!(
        call(&e.ws, "entry.get", json!({"book": e.book, "id": next_id}))["template"],
        "custom-interlude",
        "creating next manuscript sibling preserves the entry's custom template"
    );

    // Secondary in-book prose and non-book `mod-description` do not mount duplicate folio chrome.
    let (secondary_view, vcx2) = open(&mut vcx1.cx.clone(), &e, "mod-notes");
    let secondary_doc = format!("body:{ms_custom}/mod-notes");
    let sec_info = secondary_view
        .read_with(&vcx2, |v, _| v.editor().unwrap())
        .read_with(&vcx2, |v, _| v.page_info().unwrap());
    assert!(!sec_info.chrome);
    assert!(
        vcx2.cx
            .update(|cx| dr_view_page::page_views(&secondary_doc, cx).is_none())
    );

    let (desc_view, vcx3) = open(&mut vcx1.cx.clone(), &e, "mod-description");
    let desc_doc = format!("body:{ms_custom}/mod-description");
    let desc_info = desc_view
        .read_with(&vcx3, |v, _| v.editor().unwrap())
        .read_with(&vcx3, |v, _| v.page_info().unwrap());
    assert!(!desc_info.chrome);
    assert!(
        vcx3.cx
            .update(|cx| dr_view_page::page_views(&desc_doc, cx).is_none())
    );

    // 2. Outside manuscript: `PageKind::Other`, template name folio, and entry color precedence
    //    (own color_field > active lane color > None when lane's level switch is off).
    let note_id = call(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "parent": ideas_root, "template": "custom-interlude", "title": "城北剪影"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &e.ws,
        "membership.add",
        json!({"book": e.book, "host": lane_host, "member": note_id}),
    );
    e.entry = note_id.clone();

    let (note_view, mut vcx4) = open(&mut vcx1.cx.clone(), &e, "mod-prose");
    let note_doc = format!("body:{note_id}/mod-prose");
    wait(&mut vcx4, |cx| {
        cx.update(|_, cx| dr_view_page::page_views(&note_doc, cx).is_some())
    });
    let note_ed = note_view.read_with(&vcx4, |v, _| v.editor().unwrap());
    let note_info = note_ed.read_with(&vcx4, |v, _| v.page_info().unwrap());
    assert_eq!(note_info.kind, PageKind::Other);
    assert!(note_info.chrome);
    assert_eq!(note_info.number, None);
    assert_eq!(note_info.template_name, "幕间");
    assert!(note_info.storyline.is_some());
    assert_eq!(note_info.color.as_deref(), Some("#2a6f97"));

    call(
        &e.ws,
        "module.set_field",
        json!({"book": e.book, "entry": note_id, "module": "mod-fields", "field": "tint", "value": "#d97706"}),
    );
    wait(&mut vcx4, |cx| {
        note_ed.read_with(cx, |v, _| {
            v.page_info()
                .is_some_and(|p| p.color.as_deref() == Some("#d97706"))
        })
    });
    assert_eq!(
        Book::load(&e.ws, &e.book)
            .unwrap()
            .v3()
            .unwrap()
            .appearance(&note_id)
            .unwrap()
            .color
            .as_deref(),
        Some("#d97706")
    );

    call(
        &e.ws,
        "module.set_field",
        json!({"book": e.book, "entry": note_id, "module": "mod-fields", "field": "tint", "value": null}),
    );
    call(
        &e.ws,
        "entry.set_level",
        json!({"book": e.book, "id": lane_host, "level": false}),
    );
    wait(&mut vcx4, |cx| {
        note_ed.read_with(cx, |v, _| {
            v.page_info()
                .is_some_and(|p| p.storyline.is_none() && p.color.is_none())
        })
    });
    assert_eq!(
        Book::load(&e.ws, &e.book)
            .unwrap()
            .v3()
            .unwrap()
            .appearance(&note_id)
            .unwrap()
            .color,
        None
    );

    call(
        &e.ws,
        "entry.set_level",
        json!({"book": e.book, "id": lane_host, "level": true}),
    );
    wait(&mut vcx4, |cx| {
        note_ed.read_with(cx, |v, _| {
            v.page_info()
                .is_some_and(|p| p.storyline.is_some() && p.color.as_deref() == Some("#2a6f97"))
        })
    });
    e.ws.close();
}
