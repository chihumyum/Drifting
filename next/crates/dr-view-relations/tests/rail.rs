//! RL (`kernel-v5.md` §19 「右栏的『关系』」, `v5-tracks.md` § RL): the right
//! sidebar's 「关系」 on GPUI's test platform over a real workspace with
//! dr-testkit's tiny seed: renaming (a taken name refused, the draft kept),
//! the direction and back, a description with an @ link, a draft row
//! written once both sides have an entry, adding to and taking from a
//! side, deleting rows down to the card going, 「当前」 on an entry's page,
//! the row the pointer is on for the prose, writes from elsewhere showing,
//! one undo step a write, and `RevealRelationRow` in the shell.

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_model::v3::{RelationDirection, RelationSide};
use dr_shell::book::Book;
use dr_shell::nav::Target;
use dr_shell::{Services, SettingsFile, ShellInfo, Workspace as Shell};
use dr_view_relations::rail::{RelationsRail, RowKey, open_rails};
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext as _, Entity, TestAppContext, VisualTestContext, WeakEntity, size, px,
};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    /// Live entries with a title, the tiny seed's own.
    entries: Vec<(String, String)>,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let book = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let b = Book::load(&ws, &book).unwrap();
    let entries = b
        .v3()
        .unwrap()
        .entries
        .iter()
        .filter(|e| !e.title.trim().is_empty() && e.parent.is_some())
        .map(|e| (e.id.clone(), e.title.clone()))
        .collect();
    Env {
        _dir: dir,
        ws,
        book,
        entries,
    }
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: None,
    }
}

fn init(cx: &mut TestAppContext, services: Services) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        dr_shell::init(info(), services, SettingsFile::in_memory(), cx);
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
    });
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn wait_for(cx: &mut VisualTestContext, what: &str, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.executor().advance_clock(Duration::from_millis(40));
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The rail alone in a 360 × 900 window on `e`'s book; names it opens are
/// recorded.
fn open(
    cx: &mut TestAppContext,
    e: &Env,
) -> (Entity<RelationsRail>, VisualTestContext, Rc<std::cell::RefCell<Vec<String>>>) {
    init(cx, Services::default());
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let lib = e.ws.clone();
    let window = cx.add_window(move |window, cx| {
        RelationsRail::new(WeakEntity::new_invalid(), Some(lib), book, window, cx)
    });
    let rail = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(360.), px(900.)));
    let opened = Rc::new(std::cell::RefCell::new(Vec::new()));
    let record = opened.clone();
    rail.update(&mut vcx, |r, _| {
        r.set_open(Rc::new(move |id, _, _| record.borrow_mut().push(id.to_owned())))
    });
    settle(&rail, &mut vcx);
    (rail, vcx, opened)
}

/// Waits until the rail has read the book and no write is out.
fn settle(rail: &Entity<RelationsRail>, cx: &mut VisualTestContext) {
    wait_for(cx, "the rail to settle", |cx| {
        rail.read_with(cx, |r, _| r.is_loaded())
    });
}

/// The relation named `name` as the book lists it.
fn relation(e: &Env, name: &str) -> Option<Value> {
    call(&e.ws, "relation_type.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .cloned()
}

fn pair(e: &Env, left: &str, right: &str, name: &str, direction: &str) -> Value {
    let known = relation(e, name);
    let input = match &known {
        Some(r) => json!({"book": e.book, "left": left, "right": right, "relation_type": r["id"]}),
        None => json!({"book": e.book, "left": left, "right": right,
            "new_type": {"name": name, "direction": direction}}),
    };
    call(&e.ws, "relation_row.create_pair", input)
}

fn rail_relation<'a>(
    rail: &'a RelationsRail,
    name: &str,
) -> Option<&'a dr_workspace::commands::v3::relations::RelationInfo> {
    rail.relations().iter().find(|r| r.name == name)
}

#[gpui::test]
fn a_name_is_changed_in_place_and_a_taken_one_is_refused(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    pair(&e, a, b, "RL 冤家", "symmetric");
    pair(&e, a, c, "RL 欺辱", "directed");
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 冤家").unwrap().id.clone());

    // A taken name: refused, the draft kept, 未能保存.
    cx.update(|window, cx| {
        rail.update(cx, |r, cx| r.start_rename(Some(id.clone()), window, cx))
    });
    draw(cx);
    cx.simulate_input("RL 欺辱");
    cx.simulate_keystrokes("enter");
    wait_for(cx, "the refusal", |cx| {
        rail.read_with(cx, |r, _| r.rename.as_ref().is_some_and(|n| n.failed))
    });
    assert_eq!(relation(&e, "RL 冤家").unwrap()["id"], json!(id));
    let kept = rail.read_with(cx, |r, cx| r.rename.as_ref().unwrap().field.read(cx).text());
    assert_eq!(kept, "RL 欺辱", "the draft stays");

    // Another name, and 重试.
    let field = rail.read_with(cx, |r, _| r.rename.as_ref().unwrap().field.clone());
    field.update(cx, |f, cx| f.set_text("RL 仇人", cx));
    cx.update(|window, cx| rail.update(cx, |r, cx| r.retry(window, cx)));
    settle(&rail, cx);
    assert!(rail.read_with(cx, |r, _| r.rename.is_none()));
    assert_eq!(relation(&e, "RL 仇人").unwrap()["id"], json!(id));
    assert!(rail.read_with(cx, |r, _| rail_relation(r, "RL 仇人").is_some()));

    // One undo step puts the old name back.
    e.ws.undo_in(&Actor::User, &e.book, None).unwrap().unwrap();
    assert!(relation(&e, "RL 冤家").is_some());
    settle(&rail, cx);
    wait_for(cx, "the rail to follow the undo", |cx| {
        rail.read_with(cx, |r, _| rail_relation(r, "RL 冤家").is_some())
    });
}

#[gpui::test]
fn the_direction_switches_for_the_whole_card_and_keeps_the_sides(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    pair(&e, a, b, "RL 欺辱", "directed");
    pair(&e, c, b, "RL 欺辱", "directed");
    let before = relation(&e, "RL 欺辱").unwrap()["rows"].clone();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 欺辱").unwrap().id.clone());
    rail.update(cx, |r, cx| r.toggle_direction(&id, cx));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 欺辱").unwrap()["direction"], "symmetric");
    rail.update(cx, |r, cx| r.toggle_direction(&id, cx));
    settle(&rail, cx);
    let after = relation(&e, "RL 欺辱").unwrap();
    assert_eq!(after["direction"], "directed");
    assert_eq!(after["rows"], before, "left and right stay where they were");
    assert_eq!(
        rail.read_with(cx, |r, _| rail_relation(r, "RL 欺辱").unwrap().direction),
        RelationDirection::Directed
    );
}

#[gpui::test]
fn a_description_takes_an_entry_picked_with_at(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    pair(&e, a, b, "RL 本家", "symmetric");
    // An entry whose title the @ list finds by its first letters.
    let (target, title) = e.entries[2].clone();
    let first: String = title.chars().take(2).collect();
    let (rail, mut cx, opened) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 本家").unwrap().id.clone());
    cx.update(|window, cx| rail.update(cx, |r, cx| r.start_describe(&id, window, cx)));
    draw(cx);
    cx.simulate_input("同宗，见 @");
    cx.simulate_input(&first);
    draw(cx);
    let area = rail.read_with(cx, |r, _| r.describe.as_ref().unwrap().area.clone());
    let items = area.read_with(cx, |a, _| a.at_items());
    assert!(
        items.iter().any(|i| i.target.as_ref() == target),
        "the @ list finds {title} by {first}: {items:?}"
    );
    // Picking it (a press here) puts the name there as a link.
    let item = items.iter().find(|i| i.target.as_ref() == target).unwrap().clone();
    cx.update(|window, cx| area.update(cx, |a, cx| a.pick(&item, window, cx)));
    draw(cx);
    // Enter saves (one paragraph).
    cx.simulate_keystrokes("enter");
    settle(&rail, cx);
    let stored = relation(&e, "RL 本家").unwrap()["description"].clone();
    let text = stored["text"].as_str().unwrap();
    assert_eq!(text, format!("同宗，见 {title}"));
    let start = "同宗，见 ".chars().count();
    assert!(
        stored["links"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l["entry"] == target.as_str()
                && l["start"] == start
                && l["end"] == start + title.chars().count()),
        "{stored}"
    );
    assert!(rail.read_with(cx, |r, _| r.describe.is_none()));

    // Shown with the link: a press on it opens the entry, not the editor.
    rail.read_with(cx, |r, _| {
        let shown = dr_view_relations::rail::shown_text(&rail_relation(r, "RL 本家").unwrap().description);
        assert_eq!(dr_view_relations::rail::link_targets(&shown).into_iter().collect::<Vec<_>>(), vec![target.clone()]);
    });
    let _ = opened;

    // The entry goes to Recently Deleted: the words read as plain text.
    call(&e.ws, "entry.trash", json!({"book": e.book, "id": target}));
    wait_for(cx, "the trashed link to read as words", |cx| {
        rail.read_with(cx, |r, _| {
            rail_relation(r, "RL 本家").is_some_and(|x| x.description.links.is_empty())
        })
    });
    call(&e.ws, "entry.restore", json!({"book": e.book, "id": target}));
    wait_for(cx, "the link to come back", |cx| {
        rail.read_with(cx, |r, _| {
            rail_relation(r, "RL 本家").is_some_and(|x| x.description.links.len() == 1)
        })
    });
}

#[gpui::test]
fn a_written_name_becomes_a_link_when_the_description_is_saved(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    pair(&e, a, b, "RL 雇佣", "directed");
    // An element: its name links by itself (`kernel-v5.md` §16 「自动链接」).
    let book = Book::load(&e.ws, &e.book).unwrap();
    let v3 = book.v3().unwrap();
    let element = v3
        .entries
        .iter()
        .find(|x| x.template.as_deref() == Some("tpl-character") && !x.title.trim().is_empty())
        .or_else(|| {
            v3.entries.iter().find(|x| {
                x.template.as_deref().is_some_and(|t| t.starts_with("tpl-") && t != "tpl-chapter")
                    && !x.title.trim().is_empty()
                    && x.title.chars().count() >= 2
            })
        })
        .unwrap();
    let plan = e
        .ws
        .plan_entry_text_links(
            &e.book.parse().unwrap(),
            None,
            &dr_model::v3::LinkedText::plain(format!("给{}做工", element.title)),
        )
        .unwrap();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 雇佣").unwrap().id.clone());
    cx.update(|window, cx| rail.update(cx, |r, cx| r.start_describe(&id, window, cx)));
    draw(cx);
    cx.simulate_input(&format!("给{}做工", element.title));
    cx.simulate_keystrokes("enter");
    settle(&rail, cx);
    let stored = relation(&e, "RL 雇佣").unwrap()["description"].clone();
    // What the book's own planner links is what was stored.
    assert_eq!(
        stored["links"].as_array().unwrap().len(),
        plan.links.len(),
        "{stored} vs {plan:?}"
    );
}

#[gpui::test]
fn a_new_row_is_written_once_both_sides_have_an_entry(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c, d] = [
        &e.entries[0].0,
        &e.entries[1].0,
        &e.entries[2].0,
        &e.entries[3].0,
    ];
    pair(&e, a, b, "RL 求爱", "directed");
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 求爱").unwrap().id.clone());
    rail.update(cx, |r, cx| r.add_row(&id, cx));
    let key = rail.read_with(cx, |r, _| RowKey::Draft(r.drafts()[0].key));
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Left, c, cx));
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Left, d, cx));
    draw(cx);
    assert_eq!(relation(&e, "RL 求爱").unwrap()["rows"].as_array().unwrap().len(), 1);
    // Both sides now: written, its first pair then the rest.
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Right, b, cx));
    settle(&rail, cx);
    let rows = relation(&e, "RL 求爱").unwrap()["rows"].clone();
    assert!(rail.read_with(cx, |r, _| r.drafts().is_empty()));
    // c → b lands in the row whose right is only b (the second step of
    // the rule), so one row: a, c, d → b.
    assert_eq!(rows.as_array().unwrap().len(), 1, "{rows}");
    let left: Vec<&str> = rows[0]["left"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    for x in [a, c, d] {
        assert!(left.contains(&x.as_str()), "{rows}");
    }
}

#[gpui::test]
fn names_go_out_of_a_row_and_the_last_row_takes_the_card(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    pair(&e, a, b, "RL 住在", "directed");
    let row = pair(&e, a, c, "RL 住在", "directed")["id"].as_str().unwrap().to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let key = RowKey::Stored(row.clone());
    // a → b, c: c out.
    rail.update(cx, |r, cx| r.remove_entry(&key, c, cx));
    settle(&rail, cx);
    let rows = relation(&e, "RL 住在").unwrap()["rows"].clone();
    assert_eq!(rows[0]["right"], json!([b]));
    // An added name and the row's bin.
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Right, c, cx));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 住在").unwrap()["pair_count"], 2);
    rail.update(cx, |r, cx| r.delete_row(&key, cx));
    settle(&rail, cx);
    assert!(relation(&e, "RL 住在").is_none(), "the last row took the relation");
    assert!(rail.read_with(cx, |r, _| {
        r.cards()
            .iter()
            .all(|c| c.relation.as_ref().is_none_or(|x| x.name != "RL 住在"))
    }));
    // One undo step: the row and the relation come back.
    e.ws.undo_in(&Actor::User, &e.book, None).unwrap().unwrap();
    assert!(relation(&e, "RL 住在").is_some());
}

#[gpui::test]
fn a_new_card_is_named_then_filled_and_an_empty_one_goes(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let shown = rail.read_with(cx, |r, _| r.cards().len());
    // Named nothing: no relation.
    cx.update(|window, cx| rail.update(cx, |r, cx| r.new_card(window, cx)));
    draw(cx);
    assert_eq!(rail.read_with(cx, |r, _| r.cards().len()), shown + 1);
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(rail.read_with(cx, |r, _| r.cards().len()), shown);
    // Named: one-way, its draft row filled.
    cx.update(|window, cx| rail.update(cx, |r, cx| r.new_card(window, cx)));
    draw(cx);
    cx.simulate_input("RL 师徒");
    cx.simulate_keystrokes("enter");
    settle(&rail, cx);
    let made = relation(&e, "RL 师徒").unwrap();
    assert_eq!(made["direction"], "directed");
    let key = rail.read_with(cx, |r, _| {
        let d = &r.drafts()[0];
        assert_eq!(d.relation.as_deref(), made["id"].as_str());
        RowKey::Draft(d.key)
    });
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Left, a, cx));
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Right, b, cx));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 师徒").unwrap()["pair_count"], 1);
    // The newest card is on top.
    assert_eq!(
        rail.read_with(cx, |r, _| r.cards()[0].relation.as_ref().unwrap().name.clone()),
        "RL 师徒"
    );

    // A named card whose draft is binned before it is filled goes.
    cx.update(|window, cx| rail.update(cx, |r, cx| r.new_card(window, cx)));
    draw(cx);
    cx.simulate_input("RL 空");
    cx.simulate_keystrokes("enter");
    settle(&rail, cx);
    assert!(relation(&e, "RL 空").is_some());
    let key = rail.read_with(cx, |r, _| RowKey::Draft(r.drafts()[0].key));
    rail.update(cx, |r, cx| r.delete_row(&key, cx));
    settle(&rail, cx);
    assert!(relation(&e, "RL 空").is_none());
}

#[gpui::test]
fn current_keeps_the_rows_of_the_page_entry(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c, d] = [
        &e.entries[0].0,
        &e.entries[1].0,
        &e.entries[2].0,
        &e.entries[3].0,
    ];
    pair(&e, a, b, "RL 冤家", "symmetric");
    pair(&e, c, d, "RL 本家", "symmetric");
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| {
        r.set_front(
            Some(Target::Entry {
                id: a.parse().unwrap(),
                module: None,
            }),
            cx,
        );
        r.set_current_only(true, cx);
    });
    wait_for(cx, "the page's entries", |cx| {
        rail.read_with(cx, |r, _| r.page.is_some())
    });
    let names: Vec<String> = rail.read_with(cx, |r, _| {
        r.cards()
            .iter()
            .filter_map(|c| c.relation.as_ref().map(|x| x.name.clone()))
            .collect()
    });
    assert!(names.contains(&"RL 冤家".to_owned()), "{names:?}");
    assert!(!names.contains(&"RL 本家".to_owned()), "{names:?}");
    rail.update(cx, |r, cx| r.set_current_only(false, cx));
    let all = rail.read_with(cx, |r, _| r.cards().len());
    assert!(all > names.len());
}

#[gpui::test]
fn the_row_under_the_pointer_is_offered_to_the_prose(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    let row = pair(&e, a, b, "RL 欺辱", "directed")["id"].as_str().unwrap().to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| r.set_hover(Some(RowKey::Stored(row.clone())), cx));
    let hot = cx.update(|_, cx| dr_shell::relations::rail_hover(cx)).unwrap();
    assert_eq!(hot.row, row);
    assert_eq!(hot.name, "RL 欺辱");
    assert!(hot.directed);
    assert_eq!((hot.left, hot.right), (vec![a.clone()], vec![b.clone()]));
    rail.update(cx, |r, cx| r.set_hover(None, cx));
    assert!(cx.update(|_, cx| dr_shell::relations::rail_hover(cx)).is_none());
}

#[gpui::test]
fn a_write_from_elsewhere_shows_in_the_rail(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    // The Agent's own commands, not the rail's.
    e.ws.call(
        &Actor::Agent {
            session: "rl-test".into(),
            turn: 1,
            call: "call-1".into(),
        },
        "relation_row.create_pair",
        json!({"book": e.book, "left": a, "right": b, "new_type": {"name": "RL Agent 写的"}}),
    )
    .unwrap();
    wait_for(cx, "the Agent's relation", |cx| {
        rail.read_with(cx, |r, _| rail_relation(r, "RL Agent 写的").is_some())
    });
}

#[gpui::test]
fn reveal_relation_row_opens_the_rail_on_the_row(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    let row = pair(&e, a, b, "RL 冤家", "symmetric")["id"].as_str().unwrap().to_owned();
    init(
        cx,
        Services {
            library: Some(e.ws.clone()),
            book: Some(e.book.clone()),
            ..Default::default()
        },
    );
    cx.update(dr_view_relations::init);
    let (shell, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    cx.simulate_resize(size(px(1400.), px(900.)));
    wait_for(cx, "the book", |cx| {
        shell.read_with(cx, |ws, _| ws.book.id == e.book)
    });
    cx.update(|window, cx| {
        window.dispatch_action(
            Box::new(dr_shell::actions::RevealRelationRow { row: row.clone() }),
            cx,
        )
    });
    wait_for(cx, "the rail on the row", |cx| {
        let (open, tab) = shell.read_with(cx, |ws, _| (ws.right.open, ws.right.panes.focused_tab()));
        open && tab == dr_shell::workspace::RightTab::Relations
            && cx.update(|_, cx| open_rails(cx))
                .iter()
                .any(|r| r.read(cx).flashing() == Some(row.as_str()))
    });
    assert!(cx.update(|_, cx| dr_shell::relations::pending_reveal(&e.book, cx)).is_none());
}
