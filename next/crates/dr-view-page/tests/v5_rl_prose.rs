//! RL: a relation placed from a body's composer is shown in the right
//! column: the page dispatches `RevealRelationRow` with the row it landed in
//! (`kernel-v5.md` §19 「就地建关系」). The rail is another track's; here a
//! listener on the app stands in for it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::actions::RevealRelationRow;
use dr_shell::{
    Services, SettingsFile, ShellInfo, book::Book, pages::PageViewHost, v3::ModuleHost,
};
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
    // Another visible pair belongs to a different row: rail hover must
    // restrict the layer to its row rather than all visible relations.
    call(
        &ws,
        "relation_row.create_pair",
        json!({"book": book, "left": wh, "right": xn,
            "new_type": {"name": "相识", "direction": "symmetric"}}),
    );
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
        dr_view_page::init(cx);
    });
    let shown = Rc::new(RefCell::new(Vec::<String>::new()));
    {
        let shown = shown.clone();
        cx.update(|cx| {
            cx.on_action(move |a: &RevealRelationRow, _| shown.borrow_mut().push(a.row.clone()));
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
    // Drive the shell seam, not the editor global. The mounted page host
    // must relay it into the actual painted prose, then remove the lines
    // when the rail clears its hovered row.
    vcx.update(|_, cx| {
        dr_shell::relations::set_rail_hover(
            Some(dr_shell::relations::RailRow {
                book: book.clone(),
                row: row.clone(),
                name: "欺辱".into(),
                directed: true,
                left: vec![aq.clone()],
                right: vec![wh.clone()],
            }),
            cx,
        );
    });
    draw(&mut vcx);
    draw(&mut vcx);
    let lines = assist.read_with(&vcx, |a, _| {
        a.relation_drawn()
            .expect("the mounted host relays RailHover into painted prose")
            .lines
            .clone()
    });
    assert_eq!(lines.len(), 1);
    let mut endpoints = vec![lines[0].a.entry.clone(), lines[0].b.entry.clone()];
    endpoints.sort();
    let mut expected = vec![aq.clone(), wh.clone()];
    expected.sort();
    assert_eq!(endpoints, expected);
    vcx.update(|_, cx| dr_shell::relations::set_rail_hover(None, cx));
    draw(&mut vcx);
    draw(&mut vcx);
    assert!(assist.read_with(&vcx, |a, _| a.relation_drawn().is_none()));
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
    assert!(
        assist.read_with(&vcx, |a, _| a.card().is_some()),
        "阿Q's card"
    );
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
    let kind = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|kind| kind["name"] == "欺辱")
        .unwrap();
    assert_eq!(kind["rows"].as_array().unwrap().len(), 1);
    assert_eq!(kind["rows"][0]["id"], row.as_str());
    assert_eq!(
        *shown.borrow(),
        vec![row],
        "RevealRelationRow carries the row"
    );
}

#[gpui::test]
fn an_entry_page_draws_across_body_modules_at_the_pointed_occurrence(cx: &mut TestAppContext) {
    use dr_editor::assist::relate::geom;
    use dr_shell::{nav::Target, v3::page::EntryPage};

    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open_dir(dir.path(), "multi-body").unwrap();
    let book = call(&ws, "project.create", json!({"name":"试书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let person = |title| {
        dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-character", title, None)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let aq = person("阿Q");
    let wh = person("王胡");
    let row = call(
        &ws,
        "relation_row.create_pair",
        json!({"book":book,"left":aq,"right":wh,
        "new_type":{"name":"冤家","direction":"symmetric"}}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "entry_template.remove_module",
        json!({"book":book,"template":"tpl-chapter","module":"mod-plot-grid"}),
    );
    call(
        &ws,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter",
        "module":{"id":"mod-prose-extra","kind":"prose","name":"另篇"}}),
    );
    let entry = dr_testkit::seed::acceptance::novel_entry(&ws, &book, "tpl-chapter", "试写", None)
        ["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (module, paragraphs) in [
        (
            "mod-prose",
            vec![json!({"text":"阿Q在门口。"}), json!({"text":"阿Q问好。"})],
        ),
        (
            "mod-prose-extra",
            vec![
                json!({"text":"王胡来了。"}),
                json!({"text":"过了两天。"}),
                json!({"text":"王胡走了。"}),
            ],
        ),
    ] {
        call_as(
            &Actor::Mirror,
            &ws,
            "module.set_prose",
            json!({"book":book,"owner":entry,"module":module,"paragraphs":paragraphs}),
        );
    }
    cx.executor().allow_parking();
    cx.update(|cx| {
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
        dr_view_page::init(cx);
    });
    let host = PageViewHost {
        workspace: WeakEntity::new_invalid(),
        library: ws.clone(),
        book_id: book.clone(),
        book: Rc::new(Book::load(&ws, &book).unwrap()),
    };
    let window = cx.add_window(move |_, cx| {
        EntryPage::new(
            host,
            Target::Entry {
                id: entry.parse().unwrap(),
                module: None,
            },
            cx,
        )
    });
    let page = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(1000.), px(1000.)));
    let deadline = Instant::now() + Duration::from_secs(10);
    let editors = loop {
        // Decoration rebuilds are debounced on the GPUI test clock.
        vcx.executor().advance_clock(Duration::from_millis(400));
        draw(&mut vcx);
        let editors: Vec<_> = page.read_with(&vcx, |page, cx| {
            page.prose_views()
                .filter_map(|view| view.downcast::<BodyModule>().ok())
                .filter_map(|body| body.read(cx).editor())
                .map(|e| e.read(cx).editor().clone())
                .collect()
        });
        let counts: Vec<_> = editors
            .iter()
            .map(|e| e.read_with(&vcx, |p, _| p.painted_group("links").len()))
            .collect();
        if counts == [2, 2] {
            break editors;
        }
        assert!(
            Instant::now() < deadline,
            "both bodies settle and paint their links: {counts:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    let links = |editor: usize, vcx: &VisualTestContext| {
        editors[editor].read_with(vcx, |p, _| p.painted_group("links"))
    };
    let second = links(0, &vcx)[1].clone();
    editors[0].update(&mut vcx, |_, cx| {
        cx.emit(DecorationEvent::Pointed {
            ids: vec![(second.chapter, second.key.clone())],
        });
    });
    draw(&mut vcx);
    vcx.executor().advance_clock(Duration::from_millis(500));
    draw(&mut vcx);
    draw(&mut vcx);
    let card = vcx
        .debug_bounds("dr-editor-link-card")
        .expect("the hover card is open");
    assert!(
        card.bottom() < second.boxes[0].top(),
        "the card stays clear of the line down to the second body"
    );
    let selectors = ["dr-editor-relation-label-0", "dr-editor-relation-label-1"];
    let label = vcx
        .debug_bounds(selectors[0])
        .expect("the page draws the cross-body relation");
    assert!(
        vcx.debug_bounds(selectors[1]).is_none(),
        "one pair, even though both names repeat"
    );
    let view = page.read_with(&vcx, |page, _| page.scroll_handle().bounds());
    let rows: Vec<_> = editors
        .iter()
        .flat_map(|e| e.read_with(&vcx, |p, _| p.painted_rows()))
        .filter(|r| r.bottom() > view.top() && r.top() < view.bottom())
        .collect();
    let target = links(1, &vcx)[0].boxes[0];
    let curve = geom::curve(&links(0, &vcx)[1].boxes[0], &target);
    let labels = [geom::Label {
        name: "冤家".into(),
        to: None,
    }];
    let (x, y) = geom::place_labels(
        &[curve],
        &[geom::label_width(&labels)],
        &geom::blanks(&rows),
    )[0];
    assert!(
        (label.center().x - px(x)).abs() <= px(1.) && (label.center().y - px(y)).abs() <= px(1.),
        "the label follows the exact hovered source and the nearest target: {label:?}, {x}, {y}"
    );

    editors[0].update(&mut vcx, |_, cx| {
        cx.emit(DecorationEvent::Pointed { ids: Vec::new() })
    });
    draw(&mut vcx);
    vcx.executor().advance_clock(Duration::from_millis(500));
    draw(&mut vcx);
    assert!(vcx.debug_bounds(selectors[0]).is_none());
    vcx.update(|_, cx| {
        dr_shell::relations::set_rail_hover(
            Some(dr_shell::relations::RailRow {
                book,
                row,
                name: "冤家".into(),
                directed: false,
                left: vec![aq],
                right: vec![wh],
            }),
            cx,
        )
    });
    draw(&mut vcx);
    draw(&mut vcx);
    assert!(
        vcx.debug_bounds(selectors[0]).is_some(),
        "the right rail also draws across the page"
    );
    assert!(vcx.debug_bounds(selectors[1]).is_none());
}
