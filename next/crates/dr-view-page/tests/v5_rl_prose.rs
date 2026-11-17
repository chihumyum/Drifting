//! RL: a relation placed from a body's composer is shown in the right
//! column: the page dispatches `RevealRelationRow` with the row it landed in
//! (`kernel-v5.md` §19 「就地建关系」). The rail is another track's; here a
//! listener on the app stands in for it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::actions::RevealRelationRow;
use dr_shell::{Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost};
use dr_view_page::v3::BodyModule;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{TestAppContext, VisualTestContext, WeakEntity, px, size};
use gpui_prose::render::{DecorationEvent, DecorationKey};
use serde_json::{Value, json};

fn call_as(actor: &Actor, ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(actor, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    call_as(&Actor::User, ws, name, input)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

#[gpui::test]
fn a_pair_placed_in_a_body_reveals_its_row(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "未庄"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let person = |name: &str| {
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-character", name, None)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let aq = person("阿Q");
    let xn = person("小尼姑");
    let wh = person("王胡");
    let row = call(
        &ws,
        "relation_row.create_pair",
        json!({"book": book, "left": aq, "right": wh,
            "new_type": {"name": "欺辱", "direction": "directed"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let root = dr_testkit::seed::acceptance::novel_root(&ws, &book, "tpl-manuscript");
    let chapter = call(
        &ws,
        "entry.create",
        json!({"book": book, "parent": root, "template": "tpl-chapter", "title": "续优胜记略"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Written as the Markdown folder writes: the names come linked.
    call_as(
        &Actor::Mirror,
        &ws,
        "module.set_prose",
        json!({"book": book, "owner": chapter, "module": "mod-prose",
            "paragraphs": [{"text": "阿Q打了王胡，又看见小尼姑。"}]}),
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
    let shown = Rc::new(RefCell::new(Vec::<String>::new()));
    {
        let shown = shown.clone();
        cx.update(|cx| {
            cx.on_action(move |a: &RevealRelationRow, _| shown.borrow_mut().push(a.row.clone()))
        });
    }
    let snapshot = Rc::new(Book::load(&ws, &book).unwrap());
    let module = snapshot
        .v3()
        .unwrap()
        .template_of(&chapter)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == "mod-prose")
        .unwrap()
        .clone();
    let host = ModuleHost {
        page: PageViewHost {
            workspace: WeakEntity::new_invalid(),
            library: ws.clone(),
            book_id: book.clone(),
            book: snapshot,
        },
        entry: chapter.clone(),
        module,
    };
    let window = cx.add_window(|window, cx| BodyModule::new(host, window, cx));
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.), px(900.)));
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(&vcx, |v, _| v.editor().is_none()) {
        draw(&mut vcx);
        assert!(Instant::now() < deadline, "the body loads");
        std::thread::sleep(Duration::from_millis(5));
    }
    let editor = view.read_with(&vcx, |v, _| v.editor().unwrap());
    let prose = editor.read_with(&vcx, |e, _| e.editor().clone());
    let assist = editor.read_with(&vcx, |e, _| e.assist().clone());
    for _ in 0..3 {
        vcx.executor().advance_clock(Duration::from_millis(400));
        draw(&mut vcx);
    }
    // The page gave the composer its words.
    prose.update(&mut vcx, |_, cx| {
        cx.emit(DecorationEvent::Pointed {
            ids: vec![(
                0,
                DecorationKey {
                    group: "links".into(),
                    id: "l0".into(),
                },
            )],
        })
    });
    vcx.executor().advance_clock(Duration::from_millis(300));
    draw(&mut vcx);
    draw(&mut vcx);
    assert!(assist.read_with(&vcx, |a, _| a.card().is_some()), "阿Q's card");
    assist.update_in(&mut vcx, |a, window, cx| a.start_relation(window, cx));
    draw(&mut vcx);
    assist.update(&mut vcx, |a, cx| {
        a.relation_pick(&xn, None, cx);
        a.set_relation_name("欺辱", cx);
    });
    let placed = assist.update_in(&mut vcx, |a, window, cx| a.relation_commit(window, cx));
    assert!(placed);
    draw(&mut vcx);
    draw(&mut vcx);
    // 阿Q → 王胡 was the row whose left is only 阿Q: 小尼姑 joined it.
    let rows = call(&ws, "relation_type.list", json!({"book": book}));
    assert_eq!(rows[0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["rows"][0]["id"], row.as_str());
    assert_eq!(*shown.borrow(), vec![row], "RevealRelationRow carries the row");
}
