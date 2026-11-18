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
use gpui::{Entity, TestAppContext, VisualTestContext, WeakEntity, px, size};
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

fn wait_for(
    cx: &mut VisualTestContext,
    what: &str,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) {
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
) -> (
    Entity<RelationsRail>,
    VisualTestContext,
    Rc<std::cell::RefCell<Vec<String>>>,
) {
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
        r.set_open(Rc::new(move |id, _, _| {
            record.borrow_mut().push(id.to_owned())
        }))
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
    cx.update(|window, cx| rail.update(cx, |r, cx| r.start_rename(Some(id.clone()), window, cx)));
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
    let entry =
        dr_testkit::seed::acceptance::novel_entry(&e.ws, &e.book, "tpl-character", "试书人", None);
    let target = entry["id"].as_str().unwrap();
    let title = entry["title"].as_str().unwrap();
    call(
        &e.ws,
        "module.set_field",
        json!({"book":e.book,"entry":target,
        "module":"mod-fields","field":"aliases","value":["青梧客"]}),
    );
    let (rail, mut cx, opened) = open(cx, &e);
    let cx = &mut cx;
    for query in ["青梧客", "qwk", "ssr"] {
        assert!(rail.read_with(cx, |r, _| {
            r.find_entries(query, &[])
                .iter()
                .any(|item| item.target.as_ref() == target)
        }));
    }
    assert!(rail.read_with(cx, |r, _| {
        r.find_entries("qwk", &[target.to_owned()]).is_empty()
    }));
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 本家").unwrap().id.clone());
    let area = {
        cx.update(|window, cx| rail.update(cx, |r, cx| r.start_describe(&id, window, cx)));
        draw(cx);
        rail.read_with(cx, |r, _| r.describe.as_ref().unwrap().area.clone())
    };
    cx.simulate_input("同宗，见 @青梧客");
    draw(cx);
    assert!(area.read_with(cx, |a, _| {
        a.at_items()
            .iter()
            .any(|item| item.target.as_ref() == target)
    }));
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("同宗，见 @qwk");
    draw(cx);
    let items = area.read_with(cx, |a, _| a.at_items());
    assert!(
        items.iter().any(|i| i.target.as_ref() == target),
        "{items:?}"
    );
    // Picking it (a press here) puts the name there as a link.
    let item = items
        .iter()
        .find(|i| i.target.as_ref() == target)
        .unwrap()
        .clone();
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
            .any(|l| l["entry"] == target
                && l["start"] == start
                && l["end"] == start + title.chars().count()),
        "{stored}"
    );
    assert!(rail.read_with(cx, |r, _| r.describe.is_none()));

    // The display projection keeps the picked entry identity. Click routing
    // is exercised by dr-ui/tests/linked.rs and the combined native smoke.
    rail.read_with(cx, |r, _| {
        let shown =
            dr_view_relations::rail::shown_text(&rail_relation(r, "RL 本家").unwrap().description);
        assert_eq!(
            dr_view_relations::rail::link_targets(&shown)
                .into_iter()
                .collect::<Vec<_>>(),
            vec![target.to_owned()]
        );
    });
    let _ = opened;

    // The entry goes to Recently Deleted: the words read as plain text.
    call(&e.ws, "entry.trash", json!({"book": e.book, "id": target}));
    wait_for(cx, "the trashed link to read as words", |cx| {
        rail.read_with(cx, |r, _| {
            rail_relation(r, "RL 本家").is_some_and(|x| x.description.links.is_empty())
        })
    });
    call(
        &e.ws,
        "entry.restore",
        json!({"book": e.book, "id": target}),
    );
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
                x.template
                    .as_deref()
                    .is_some_and(|t| t.starts_with("tpl-") && t != "tpl-chapter")
                    && !x.title.trim().is_empty()
                    && x.title.chars().count() >= 2
            })
        })
        .unwrap();
    let plan =
        e.ws.plan_entry_text_links(
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
    assert_eq!(
        relation(&e, "RL 求爱").unwrap()["rows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Both sides now: one explicit group, separate from the existing row.
    rail.update(cx, |r, cx| r.add_entry(&key, RelationSide::Right, b, cx));
    settle(&rail, cx);
    let rows = relation(&e, "RL 求爱").unwrap()["rows"].clone();
    assert!(rail.read_with(cx, |r, _| r.drafts().is_empty()));
    assert_eq!(rows.as_array().unwrap().len(), 2, "{rows}");
    let group = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["left"].as_array().unwrap().len() == 2)
        .unwrap();
    let mut expected = vec![c.clone(), d.clone()];
    expected.sort();
    assert_eq!(group["left"], json!(expected));
    assert_eq!(group["right"], json!([b]));
    // All of the explicit group's pairs disappear in one undo, with the
    // pre-existing a → b row intact.
    e.ws.undo_in(&Actor::User, &e.book, None).unwrap().unwrap();
    let rows = relation(&e, "RL 求爱").unwrap()["rows"].clone();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["left"], json!([a]));
    assert_eq!(rows[0]["right"], json!([b]));
}

#[gpui::test]
fn names_go_out_of_a_row_and_the_last_row_takes_the_card(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    pair(&e, a, b, "RL 住在", "directed");
    let row = pair(&e, a, c, "RL 住在", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
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
    assert!(
        relation(&e, "RL 住在").is_none(),
        "the last row took the relation"
    );
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
        rail.read_with(cx, |r, _| r.cards()[0]
            .relation
            .as_ref()
            .unwrap()
            .name
            .clone()),
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
    let row = pair(&e, a, b, "RL 欺辱", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| {
        r.set_hover(Some(RowKey::Stored(row.clone())), cx)
    });
    let hot = cx
        .update(|_, cx| dr_shell::relations::rail_hover(cx))
        .unwrap();
    assert_eq!(hot.row, row);
    assert_eq!(hot.name, "RL 欺辱");
    assert!(hot.directed);
    assert_eq!((hot.left, hot.right), (vec![a.clone()], vec![b.clone()]));
    rail.update(cx, |r, cx| r.set_hover(None, cx));
    assert!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_none()
    );
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
    let row = pair(&e, a, b, "RL 冤家", "symmetric")["id"]
        .as_str()
        .unwrap()
        .to_owned();
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
        let (open, tab) =
            shell.read_with(cx, |ws, _| (ws.right.open, ws.right.panes.focused_tab()));
        open && tab == dr_shell::workspace::RightTab::Relations
            && cx
                .update(|_, cx| open_rails(cx))
                .iter()
                .any(|r| r.read_with(cx, |rail, _| rail.flashing() == Some(row.as_str())))
    });
    assert!(
        cx.update(|_, cx| dr_shell::relations::pending_reveal(&e.book, cx))
            .is_none()
    );
    let rail = cx
        .update(|_, cx| open_rails(cx))
        .into_iter()
        .next()
        .unwrap();
    rail.update(cx, |r, cx| {
        r.set_hover(Some(RowKey::Stored(row.clone())), cx)
    });
    assert!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_some()
    );
    shell.update(cx, |ws, cx| {
        ws.right.open = false;
        cx.notify();
    });
    draw(cx);
    assert!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_none()
    );
    shell.update(cx, |ws, cx| {
        ws.right.open = true;
        cx.notify();
    });
    draw(cx);
    rail.update(cx, |r, cx| r.set_hover(Some(RowKey::Stored(row)), cx));
    shell.update(cx, |ws, cx| {
        for pane in &mut ws.right.panes.panes {
            pane.tab = dr_shell::workspace::RightTab::Review;
        }
        cx.notify();
    });
    draw(cx);
    assert!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_none()
    );
    // An old frame's callback cannot open the same synthetic id in a
    // different library, nor can an old rail write back to the released one.
    let stale_open = rail.update(cx, |r, cx| r.entry_opener(cx));
    let other = env();
    let before = shell.read_with(cx, |ws, _| ws.nav.current().cloned());
    shell.update(cx, |ws, cx| {
        ws.library = Some(other.ws.clone());
        cx.notify();
    });
    cx.update(|window, cx| stale_open(a, window, cx));
    assert_eq!(
        shell.read_with(cx, |ws, _| ws.nav.current().cloned()),
        before
    );
    let id = relation(&e, "RL 冤家").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    rail.update(cx, |r, cx| r.toggle_direction(&id, cx));
    draw(cx);
    assert_eq!(relation(&e, "RL 冤家").unwrap()["direction"], "symmetric");
}

fn sync_book(from: &Workspace, to: &Workspace, book: &str) {
    let doc = format!("book:{book}");
    let bytes = from
        .library()
        .load_copy(&doc)
        .unwrap()
        .export(loro::ExportMode::all_updates())
        .unwrap();
    to.import_remote(&doc, Some(("book", book)), bytes, &Actor::Sync)
        .unwrap();
}

#[gpui::test]
fn a_duplicate_pair_explains_and_reveals_its_row_then_the_draft_can_be_corrected(
    cx: &mut TestAppContext,
) {
    let e = env();
    let [(a, a_title), (b, b_title), (c, _)] = [&e.entries[0], &e.entries[1], &e.entries[2]];
    let row = pair(&e, a, b, "RL 草稿", "symmetric")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let id = rail.read_with(cx, |r, _| rail_relation(r, "RL 草稿").unwrap().id.clone());
    rail.update(cx, |r, cx| r.add_row(&id, cx));
    let key = rail.read_with(cx, |r, _| r.drafts()[0].key);
    // A symmetric duplicate is caught even in the opposite order.
    rail.update(cx, |r, cx| {
        let key = RowKey::Draft(key);
        r.add_entry(&key, RelationSide::Left, b, cx);
        r.add_entry(&key, RelationSide::Right, a, cx);
        let d = &r.drafts()[0];
        assert!(!d.pending && !d.failed);
        assert_eq!(
            (d.left.as_slice(), d.right.as_slice()),
            ([b.clone()].as_slice(), [a.clone()].as_slice())
        );
        let overlap = d.duplicate.as_ref().unwrap();
        assert_eq!((&overlap.left, &overlap.right, &overlap.row), (b, a, &row));
    });
    wait_for(cx, "the overlapping row flashes", |cx| {
        rail.read_with(cx, |r, _| r.flashing() == Some(row.as_str()))
    });
    assert_eq!(relation(&e, "RL 草稿").unwrap()["pair_count"], 1);
    assert_eq!(key, 1);
    assert!(cx.debug_bounds("relations-draft-1-duplicate").is_some());
    let why = format!("「{b_title} ↔ {a_title}」已经在另一行里。");
    cx.update(|_, cx| {
        let got = dr_shell::strings::tf(
            cx,
            dr_i18n::keys::v5_relations::DUPLICATE_PAIR,
            &[("pair", &format!("{b_title} ↔ {a_title}"))],
        );
        assert_eq!(got.as_ref(), why);
    });
    rail.update(cx, |r, cx| {
        let draft = RowKey::Draft(key);
        r.remove_entry(&draft, a, cx);
        assert!(
            r.drafts()[0].right.is_empty(),
            "correcting a duplicate keeps the draft"
        );
        assert!(r.drafts()[0].duplicate.is_none());
        r.add_entry(&draft, RelationSide::Right, c, cx);
        r.retry_draft(key, cx);
        r.remove_entry(&draft, b, cx);
        r.delete_row(&draft, cx);
        assert!(r.drafts()[0].pending);
        assert_eq!(r.drafts()[0].left, vec![b.clone()]);
    });
    settle(&rail, cx);
    assert!(rail.read_with(cx, |r, _| r.drafts().is_empty()));
    assert_eq!(relation(&e, "RL 草稿").unwrap()["pair_count"], 2);
    e.ws.undo_in(&Actor::User, &e.book, None).unwrap().unwrap();
    assert_eq!(relation(&e, "RL 草稿").unwrap()["pair_count"], 1);
}

#[gpui::test]
fn remote_changes_refresh_labels_rows_and_clear_the_hover(cx: &mut TestAppContext) {
    let e = env();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    let row = pair(&e, a, b, "RL 远端", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Workspace::open_dir(remote_dir.path(), "0.2.0-dev").unwrap();
    sync_book(&e.ws, &remote, &e.book);
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| {
        r.set_hover(Some(RowKey::Stored(row.clone())), cx)
    });
    let id = relation(&e, "RL 远端").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &remote,
        "relation_type.rename",
        json!({"book":e.book,"id":id,"name":"RL 远端改名"}),
    );
    call(
        &remote,
        "entry.update",
        json!({"book":e.book,"id":b,"title":"RL 远端条目"}),
    );
    sync_book(&remote, &e.ws, &e.book);
    wait_for(cx, "remote relation and entry names", |cx| {
        rail.read_with(cx, |r, _| {
            rail_relation(r, "RL 远端改名").is_some()
                && r.entry_look(b).is_some_and(|e| e.title == "RL 远端条目")
        })
    });
    assert_eq!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .unwrap()
            .name,
        "RL 远端改名"
    );
    call(
        &remote,
        "relation_row.delete",
        json!({"book":e.book,"id":row}),
    );
    sync_book(&remote, &e.ws, &e.book);
    wait_for(cx, "remote deletion clears hover", |cx| {
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_none()
    });
    assert!(rail.read_with(cx, |r, _| rail_relation(r, "RL 远端改名").is_none()));
}

#[gpui::test]
fn switching_books_discards_old_callbacks_and_hover(cx: &mut TestAppContext) {
    let e = env();
    let row = pair(&e, &e.entries[0].0, &e.entries[1].0, "RL 换书", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = call(&e.ws, "project.create", json!({"name":"RL 另一书"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    let book = Rc::new(Book::load(&e.ws, &other).unwrap());
    cx.update(|window, cx| {
        rail.update(cx, |r, cx| {
            r.set_hover(Some(RowKey::Stored(row)), cx);
            r.new_card(window, cx);
            r.rename
                .as_ref()
                .unwrap()
                .field
                .update(cx, |f, cx| f.set_text("RL 旧书异步", cx));
            r.commit_rename(window, cx);
            r.set_book(book, cx);
            r.new_card(window, cx);
            r.rename
                .as_ref()
                .unwrap()
                .field
                .update(cx, |f, cx| f.set_text("RL 新书草稿", cx));
        })
    });
    wait_for(cx, "old write complete", |_| {
        relation(&e, "RL 旧书异步").is_some()
    });
    settle(&rail, cx);
    assert!(
        cx.update(|_, cx| dr_shell::relations::rail_hover(cx))
            .is_none()
    );
    assert_eq!(
        rail.read_with(cx, |r, cx| r.rename.as_ref().unwrap().field.read(cx).text()),
        "RL 新书草稿"
    );
    assert_eq!(rail.read_with(cx, |r, _| r.book().id.clone()), other);
    assert!(rail.read_with(cx, |r, _| rail_relation(r, "RL 旧书异步").is_none()));
}

#[gpui::test]
fn current_tracks_entry_links_from_the_pages_prose(cx: &mut TestAppContext) {
    let e = env();
    let doc =
        e.ws.library()
            .docs(Some(&e.book), None)
            .unwrap()
            .into_iter()
            .find(|d| d.kind == "body")
            .unwrap()
            .doc_id;
    let dr_model::DocId::Body(body) = doc.parse().unwrap() else {
        unreachable!()
    };
    let a = body.entry().to_string();
    let refs = e.ws.library().references_from_entry(&a).unwrap();
    let others: Vec<_> = e
        .entries
        .iter()
        .filter(|(id, _)| id != &a && !refs.iter().any(|r| &r.target_id == id))
        .take(2)
        .map(|(id, _)| id.clone())
        .collect();
    let [b, c] = [&others[0], &others[1]];
    pair(&e, b, c, "RL 正文链接", "directed");
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
    wait_for(cx, "initial page set", |cx| {
        rail.read_with(cx, |r, _| r.page.is_some())
    });
    assert!(!rail.read_with(cx, |r, _| {
        r.cards()
            .iter()
            .any(|r| r.relation.as_ref().is_some_and(|r| r.name == "RL 正文链接"))
    }));
    let session = e.ws.prose_session(&doc).unwrap();
    let reader = session.reader();
    let anchor = reader.view().anchor(0..1).unwrap().encode();
    call(
        &e.ws,
        "prose.link",
        json!({"links":[{"doc":doc,"anchors":[dr_workspace::dto::AnchorBytes::from(&anchor)],"target":{"kind":"entry","id":b}}]}),
    );
    wait_for(cx, "page link index refresh", |cx| {
        rail.read_with(cx, |r, _| {
            r.cards()
                .iter()
                .any(|r| r.relation.as_ref().is_some_and(|r| r.name == "RL 正文链接"))
        })
    });
}

#[gpui::test]
fn current_whole_book_scope_follows_attached_entries(cx: &mut TestAppContext) {
    let e = env();
    let host = dr_testkit::seed::acceptance::novel_entry(
        &e.ws,
        &e.book,
        "tpl-storyline",
        "RL 收纳范围",
        None,
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let [a, b] = [&e.entries[0].0, &e.entries[1].0];
    pair(&e, a, b, "RL 收纳关系", "directed");
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| {
        r.set_front(Some(Target::Book(host.parse().unwrap())), cx);
        r.set_current_only(true, cx);
    });
    wait_for(cx, "whole book scope", |cx| {
        rail.read_with(cx, |r, _| r.page.is_some())
    });
    assert!(!rail.read_with(cx, |r, _| {
        r.cards()
            .iter()
            .any(|r| r.relation.as_ref().is_some_and(|r| r.name == "RL 收纳关系"))
    }));
    call(
        &e.ws,
        "membership.add",
        json!({"book":e.book,"host":host,"member":a}),
    );
    wait_for(
        cx,
        "attached entry visible in whole-book current scope",
        |cx| {
            rail.read_with(cx, |r, _| {
                r.cards()
                    .iter()
                    .any(|r| r.relation.as_ref().is_some_and(|r| r.name == "RL 收纳关系"))
            })
        },
    );
}

#[gpui::test]
fn a_remote_name_change_keeps_the_local_name_draft_until_explicit_retry(cx: &mut TestAppContext) {
    let e = env();
    pair(&e, &e.entries[0].0, &e.entries[1].0, "RL 原名", "directed");
    let id = relation(&e, "RL 原名").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Workspace::open_dir(remote_dir.path(), "0.2.0-dev").unwrap();
    sync_book(&e.ws, &remote, &e.book);
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    cx.update(|window, cx| {
        rail.update(cx, |r, cx| {
            r.start_rename(Some(id.clone()), window, cx);
            r.rename
                .as_ref()
                .unwrap()
                .field
                .update(cx, |f, cx| f.set_text("RL 本地名字", cx));
        })
    });
    call(
        &remote,
        "relation_type.rename",
        json!({"book":e.book,"id":id,"name":"RL 远端名字"}),
    );
    sync_book(&remote, &e.ws, &e.book);
    wait_for(cx, "remote name shown while editing", |cx| {
        rail.read_with(cx, |r, _| rail_relation(r, "RL 远端名字").is_some())
    });
    cx.update(|window, cx| rail.update(cx, |r, cx| r.commit_rename(window, cx)));
    wait_for(cx, "name conflict", |cx| {
        rail.read_with(cx, |r, _| r.rename.as_ref().is_some_and(|d| d.failed))
    });
    assert_eq!(relation(&e, "RL 远端名字").unwrap()["id"], id);
    assert_eq!(
        rail.read_with(cx, |r, cx| r.rename.as_ref().unwrap().field.read(cx).text()),
        "RL 本地名字"
    );
    settle(&rail, cx);
    cx.update(|window, cx| rail.update(cx, |r, cx| r.retry(window, cx)));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 本地名字").unwrap()["id"], id);
    assert!(rail.read_with(cx, |r, _| r.rename.is_none()));
}

#[gpui::test]
fn a_remote_description_change_keeps_the_local_linked_draft(cx: &mut TestAppContext) {
    let e = env();
    pair(
        &e,
        &e.entries[0].0,
        &e.entries[1].0,
        "RL 描述并发",
        "directed",
    );
    let id = relation(&e, "RL 描述并发").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Workspace::open_dir(remote_dir.path(), "0.2.0-dev").unwrap();
    sync_book(&e.ws, &remote, &e.book);
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    cx.update(|window, cx| {
        rail.update(cx, |r, cx| {
            r.start_describe(&id, window, cx);
            r.describe
                .as_ref()
                .unwrap()
                .area
                .update(cx, |a, cx| a.set_text("本地描述", cx));
        })
    });
    call(
        &remote,
        "relation_type.set_description",
        json!({"book":e.book,"id":id,"description":"远端描述"}),
    );
    sync_book(&remote, &e.ws, &e.book);
    wait_for(cx, "remote description shown", |cx| {
        rail.read_with(cx, |r, _| {
            rail_relation(r, "RL 描述并发").is_some_and(|r| r.description.text == "远端描述")
        })
    });
    rail.update(cx, |r, cx| r.commit_describe(cx));
    wait_for(cx, "description conflict", |cx| {
        rail.read_with(cx, |r, _| r.describe.as_ref().is_some_and(|d| d.failed))
    });
    assert_eq!(
        relation(&e, "RL 描述并发").unwrap()["description"]["text"],
        "远端描述"
    );
    assert_eq!(
        rail.read_with(cx, |r, cx| r
            .describe
            .as_ref()
            .unwrap()
            .area
            .read(cx)
            .draft()
            .text
            .clone()),
        "本地描述"
    );
}

#[gpui::test]
fn deleting_a_last_draft_cannot_delete_an_unseen_remote_row(cx: &mut TestAppContext) {
    let e = env();
    let id = call(
        &e.ws,
        "relation_type.create",
        json!({"book":e.book,"name":"RL 空卡并发","direction":"directed"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Workspace::open_dir(remote_dir.path(), "0.2.0-dev").unwrap();
    sync_book(&e.ws, &remote, &e.book);
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    rail.update(cx, |r, cx| r.add_row(&id, cx));
    let key = rail.read_with(cx, |r, _| r.drafts()[0].key);
    let remote_row = call(
        &remote,
        "relation_row.create_pair",
        json!({"book":e.book,"relation_type":id,"left":e.entries[0].0,"right":e.entries[1].0}),
    )["id"]
        .clone();
    sync_book(&remote, &e.ws, &e.book);
    // Do not pump the event loop between the import and this old frame's bin.
    rail.update(cx, |r, cx| {
        assert!(rail_relation(r, "RL 空卡并发").unwrap().rows.is_empty());
        r.delete_row(&RowKey::Draft(key), cx);
        assert!(r.drafts()[0].pending);
    });
    wait_for(cx, "empty-card conflict", |cx| {
        rail.read_with(cx, |r, _| {
            r.drafts().iter().any(|d| d.key == key && d.failed)
        })
    });
    assert_eq!(
        relation(&e, "RL 空卡并发").unwrap()["rows"][0]["id"],
        remote_row
    );
    settle(&rail, cx);
    // Once that row is shown, retry only discards the local empty draft.
    rail.update(cx, |r, cx| r.retry_draft(key, cx));
    settle(&rail, cx);
    assert!(rail.read_with(cx, |r, _| r.drafts().is_empty()));
    assert_eq!(
        relation(&e, "RL 空卡并发").unwrap()["rows"][0]["id"],
        remote_row
    );
}

#[gpui::test]
fn a_new_card_cannot_be_binned_while_its_name_is_pending(cx: &mut TestAppContext) {
    let e = env();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    // One foreground update holds the deterministic background executor before
    // it can start the accepted command. Exercise the bin in that pending gap.
    cx.update(|window, cx| {
        rail.update(cx, |r, cx| {
            r.new_card(window, cx);
            r.rename
                .as_ref()
                .unwrap()
                .field
                .update(cx, |f, cx| f.set_text("RL 保存中", cx));
            let key = RowKey::Draft(r.drafts()[0].key);
            r.commit_rename(window, cx);
            assert!(r.rename.as_ref().unwrap().pending);
            assert!(relation(&e, "RL 保存中").is_none());
            r.delete_row(&key, cx);
            assert_eq!(r.drafts().len(), 1);
            assert!(r.rename.as_ref().unwrap().pending);
        })
    });
    settle(&rail, cx);
    let id = relation(&e, "RL 保存中").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        rail.read_with(cx, |r, _| r.drafts()[0].relation.clone()),
        Some(id)
    );
}

fn remote_row_change(e: &Env, row: &str, side: &str, entry: &str) {
    let remote_dir = tempfile::tempdir().unwrap();
    let remote = Workspace::open_dir(remote_dir.path(), "0.2.0-dev").unwrap();
    sync_book(&e.ws, &remote, &e.book);
    call(
        &remote,
        "relation_row.add_entry",
        json!({"book":e.book,"id":row,"side":side,"entry":entry}),
    );
    sync_book(&remote, &e.ws, &e.book);
}

#[gpui::test]
fn adding_a_member_merges_a_remote_addition_on_the_same_side(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c, d] = [
        &e.entries[0].0,
        &e.entries[1].0,
        &e.entries[2].0,
        &e.entries[3].0,
    ];
    let row = pair(&e, a, b, "RL 同侧并发", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    remote_row_change(&e, &row, "left", c);
    rail.update(cx, |r, cx| {
        r.add_entry(&RowKey::Stored(row), RelationSide::Left, d, cx)
    });
    settle(&rail, cx);
    let value = relation(&e, "RL 同侧并发").unwrap();
    assert_eq!(value["pair_count"], 3);
    let left = value["rows"][0]["left"].as_array().unwrap();
    assert!(left.contains(&json!(a)) && left.contains(&json!(c)) && left.contains(&json!(d)));
}

#[gpui::test]
fn adding_a_member_refuses_an_unseen_opposite_side(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c, d] = [
        &e.entries[0].0,
        &e.entries[1].0,
        &e.entries[2].0,
        &e.entries[3].0,
    ];
    let row = pair(&e, a, b, "RL 对侧并发", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    remote_row_change(&e, &row, "right", c);
    rail.update(cx, |r, cx| {
        r.add_entry(&RowKey::Stored(row), RelationSide::Left, d, cx)
    });
    settle(&rail, cx);
    let value = relation(&e, "RL 对侧并发").unwrap();
    assert_eq!(value["pair_count"], 2);
    assert_eq!(value["rows"][0]["left"], json!([a]));
}

#[gpui::test]
fn deleting_a_row_refuses_unseen_remote_members(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    let row = pair(&e, a, b, "RL 删行并发", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    remote_row_change(&e, &row, "left", c);
    rail.update(cx, |r, cx| r.delete_row(&RowKey::Stored(row), cx));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 删行并发").unwrap()["pair_count"], 2);
}

#[gpui::test]
fn removing_a_member_refuses_unseen_remote_pairs(cx: &mut TestAppContext) {
    let e = env();
    let [a, b, c] = [&e.entries[0].0, &e.entries[1].0, &e.entries[2].0];
    let row = pair(&e, a, b, "RL 移出并发", "directed")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (rail, mut cx, _) = open(cx, &e);
    let cx = &mut cx;
    remote_row_change(&e, &row, "right", c);
    rail.update(cx, |r, cx| r.remove_entry(&RowKey::Stored(row), a, cx));
    settle(&rail, cx);
    assert_eq!(relation(&e, "RL 移出并发").unwrap()["pair_count"], 2);
}
