//! F6 consumes G4's actual v3 panel without losing module or paragraph identity.
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace, book::Book, nav::Target};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{AppContext as _, Entity, Focusable, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}

fn fixture() -> (tempfile::TempDir, Library, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let mut ids = vec![];
    for seed in [
        dr_testkit::seed::DEFAULT_SEED,
        dr_testkit::seed::DEFAULT_SEED + 1,
    ] {
        let made = dr_testkit::seed::generate_v3(dr_testkit::seed::Preset::Tiny, seed).unwrap();
        ids.push(made.books[0].book_id().to_string());
        made.write_to(&store).unwrap();
    }
    assert_ne!(ids[0], ids[1]);
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, lib, ids)
}

fn chapter(lib: &Library, book: &str) -> String {
    call(lib, "entry.list", json!({"book":book,"all":true}))
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        // Renderer probe: F6 must return the keyboard to a retained module,
        // even when choosing a hit leaves the same page in front.
        dr_shell::v3::add_module_view(cx, "prose", |_, window, cx| {
            let field = cx.new(|cx| dr_ui::input::TextField::new("search-focus-probe", window, cx));
            let focus = field.focus_handle(cx);
            dr_shell::v3::Rendered::new(field).focus(focus)
        });
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: None,
            },
            Services {
                library: Some(lib.clone()),
                book: Some(book.to_owned()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        )
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait(&view, cx, |ws, _| ws.book.v3().is_some());
    (view, cx)
}

fn wait(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &gpui::App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "search host did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn search(view: &Entity<Workspace>, cx: &mut VisualTestContext, query: &str) -> Value {
    view.update_in(cx, |ws, w, cx| ws.toggle_search(w, cx));
    let panel = view.read_with(cx, |ws, _| ws.search.clone().unwrap());
    panel.update(cx, |p, cx| p.set_query(query, cx));
    wait(view, cx, |ws, cx| {
        ws.search_state(cx).is_some_and(|s| {
            s["searching"] == false && s["groups"].as_array().is_some_and(|g| !g.is_empty())
        })
    });
    view.read_with(cx, |ws, cx| ws.search_state(cx).unwrap())
}

fn choose(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    target: &Target,
    line: Option<u32>,
) {
    cx.simulate_keystrokes("enter");
    wait(view, cx, |ws, _| {
        ws.search.is_none() && ws.nav.current() == Some(target)
    });
    wait(view, cx, |ws, cx| {
        ws.editors
            .get(&target.key())
            .and_then(|p| p.v3.as_ref())
            .is_some_and(|p| p.read(cx).revealed.map(|l| l.start) == line)
    });
    let focus = view.read_with(cx, |ws, cx| {
        ws.editors[&target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx)
            .preferred_focus()
    });
    cx.update(|window, _| {
        assert!(
            focus.is_focused(window),
            "the selected page gets the keyboard back: {target:?}"
        )
    });
}

#[gpui::test]
fn actual_panel_keeps_title_module_and_material_destinations(cx: &mut TestAppContext) {
    let (_dir, lib, books) = fixture();
    let book = &books[0];
    let id = chapter(&lib, book);
    call(
        &lib,
        "entry.update",
        json!({"book":book,"id":id,"title":"F6SearchTitle"}),
    );
    let prose = call(
        &lib,
        "module.read_prose",
        json!({"book":book,"owner":id,"module":"mod-prose"}),
    );
    call(
        &lib,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":{"id":"second-body","kind":"prose","name":"Second body"}}),
    );
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":id,"module":"second-body","paragraphs":[{"text":prose["paragraphs"][0]["text"]},{"text":format!("F6SearchBody {}",prose["paragraphs"][1]["text"].as_str().unwrap())}]}),
    );
    let snapshot = Book::load(&lib, book).unwrap();
    let material = snapshot
        .v3()
        .unwrap()
        .materials
        .iter()
        .find(|m| m.kind == "text")
        .unwrap()
        .id
        .clone();
    let doc = format!("material:{material}");
    let body = call(&lib, "prose.read", json!({"doc":doc}));
    let p = &body["paragraphs"][0];
    call(
        &lib,
        "prose.replace",
        json!({"doc":doc,"block_id":p["block_id"],"find":p["text"],"replace":format!("F6SearchMaterial {}",p["text"].as_str().unwrap())}),
    );
    for d in lib.library().docs(Some(book), None).unwrap() {
        lib.library().reindex_doc(&d.doc_id).unwrap();
    }
    let before = lib.observe(&format!("book:{book}")).unwrap().version;
    let (view, cx) = setup(cx, &lib, book);
    for (query, key, line) in [
        ("F6SearchTitle", format!("entry:{id}"), None),
        ("F6SearchBody", format!("entry:{id}/second-body"), Some(3)),
        ("F6SearchBody", format!("entry:{id}/second-body"), Some(3)),
        ("F6SearchMaterial", format!("material:{material}"), Some(1)),
    ] {
        let state = search(&view, cx, query);
        assert_eq!(state["version"], 3);
        assert_eq!(state["groups"][0]["target"], key);
        assert_eq!(state["groups"][0]["rows"][0]["line"], json!(line));
        choose(&view, cx, &Target::from_key(&key).unwrap(), line);
    }
    assert_eq!(
        before,
        lib.observe(&format!("book:{book}")).unwrap().version,
        "search and navigation are read-only"
    );
    search(&view, cx, "F6SearchTitle");
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |ws, _| ws.search.is_none()));
}

#[gpui::test]
fn changing_books_drops_the_panel_and_refuses_its_late_event(cx: &mut TestAppContext) {
    let (_dir, lib, books) = fixture();
    let ids: Vec<_> = books
        .iter()
        .map(|book| {
            let id = chapter(&lib, book);
            call(
                &lib,
                "entry.update",
                json!({"book":book,"id":id,"title":"F6IsolatedSearch"}),
            );
            id
        })
        .collect();
    let (view, cx) = setup(cx, &lib, &books[0]);
    search(&view, cx, "F6IsolatedSearch");
    let old = view.read_with(cx, |ws, _| ws.search.clone().unwrap());
    view.update_in(cx, |ws, w, cx| ws.open_book(&books[1], w, cx));
    wait(&view, cx, |ws, _| {
        ws.book_id == books[1] && ws.book.v3().is_some()
    });
    assert!(view.read_with(cx, |ws, _| ws.search.is_none()));
    let state = search(&view, cx, "F6IsolatedSearch");
    let expected = format!("entry:{}", ids[1]);
    assert_eq!(state["groups"][0]["target"], expected);
    old.update(cx, |_, cx| {
        cx.emit(dr_view_search::SearchEvent::JumpV3(
            dr_view_search::v3::Jump {
                target: dr_view_search::v3::Target::Entry {
                    id: ids[0].clone(),
                    module: Some("mod-prose".into()),
                },
                line: Some(3),
            },
        ))
    });
    cx.run_until_parked();
    assert!(
        view.read_with(cx, |ws, _| ws.search.is_some()),
        "a stale panel cannot close the new search"
    );
    choose(&view, cx, &Target::from_key(&expected).unwrap(), None);
    view.read_with(cx, |ws, _| {
        assert!(
            !ws.nav
                .tabs()
                .iter()
                .any(|t| t.leaves().any(|l| l.target.key().contains(&ids[0])))
        )
    });
}

#[gpui::test]
fn opening_search_wins_over_an_older_renderer_focus_handoff(cx: &mut TestAppContext) {
    let (_dir, lib, books) = fixture();
    let id = chapter(&lib, &books[0]);
    let (view, cx) = setup(cx, &lib, &books[0]);
    let target = Target::from_key(&format!("entry:{id}/mod-prose")).unwrap();
    view.update(cx, |ws, cx| {
        ws.open(target.clone(), dr_shell::nav::Open::KEEP, cx)
    });
    wait(&view, cx, |ws, _| {
        ws.editors
            .get(&target.key())
            .is_some_and(|p| p.v3.is_some())
    });
    view.update_in(cx, |ws, window, cx| {
        let focus = ws.editors[&target.key()]
            .v3
            .as_ref()
            .unwrap()
            .read(cx)
            .preferred_focus();
        // A prose renderer queues this when its wrapper receives focus.
        // Opening a newer overlay must take precedence over that old request.
        window.defer(cx, move |window, cx| focus.focus(window, cx));
        ws.toggle_search(window, cx);
    });
    cx.run_until_parked();
    let focus = view.read_with(cx, |ws, cx| ws.search.as_ref().unwrap().focus_handle(cx));
    cx.update(|window, _| {
        assert!(
            focus.is_focused(window),
            "the newer search keeps the keyboard"
        )
    });
}
