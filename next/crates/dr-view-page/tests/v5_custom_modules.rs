//! CM2 (`custom-modules.md` §4, §16 items 5 and 6) on GPUI's test platform:
//! a custom module on its entry's page, filled in place through the page's
//! controls and read back from the book; a list's items added, taken away
//! and moved, nested lists too, each change one step of undo; a copy this
//! build cannot read drawn as its name with the values untouched; a copy
//! replaced while the page is open (its values kept, the words being typed
//! kept); the module filling the middle column and leaving it; an entry
//! name's hover card with the module's 一行. The modules are dr-testkit's
//! samples (`fixtures/modules/`).

use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo,
    book::Book,
    nav::{Open, Target},
    pages::PageViewHost,
    settings::registry,
    v3::ModuleHost,
    workspace::{FilledModule, ModuleFill},
};
use dr_ui::Appearance;
use dr_view_page::custom::CustomModule;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    AppContext as _, Entity, Modifiers, TestAppContext, VisualTestContext, WeakEntity, point, px,
    size,
};
use loro::ExportMode;
use serde_json::{Value, json};

const FORESHADOWING: &str =
    include_str!("../../dr-testkit/fixtures/modules/foreshadowing.driftingmodule");
const ARC: &str = include_str!("../../dr-testkit/fixtures/modules/character-arc.driftingmodule");
const CHRONOLOGY: &str =
    include_str!("../../dr-testkit/fixtures/modules/world-chronology.driftingmodule");
const MAGIC: &str = include_str!("../../dr-testkit/fixtures/modules/magic-rule.driftingmodule");

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    entry: String,
    /// My module's id.
    module: String,
}

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

/// A book with a template `tpl-mod` drawing `raw` as module `mod-c` after a
/// body, and an entry 「第一个」 of it.
fn env(raw: &str) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = dr_store::Library::open(dir.path().join("lib"), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = call(&ws, "project.create", json!({"name": "自定义模块"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let module = call(
        &ws,
        "custom_module.create",
        json!({"value": serde_json::from_str::<Value>(raw).unwrap()}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &ws,
        "entry_template.put",
        json!({"book": book, "template": {
            "id": "tpl-mod", "name": "有模块的", "modules": [
                {"id": "mod-text", "kind": "prose", "name": "正文"},
                {"id": "mod-c", "kind": "custom", "name": "自定义", "config": {"module": module}}
            ]
        }}),
    );
    let entry = call(
        &ws,
        "entry.create",
        json!({"book": book, "title": "第一个", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        dir,
        ws,
        book,
        entry,
        module,
    }
}

fn read(e: &Env) -> Value {
    call(
        &e.ws,
        "module.read_custom",
        json!({"book": e.book, "entry": e.entry, "module": "mod-c"}),
    )
}

fn shell_init(cx: &mut TestAppContext) {
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            dr_shell::init(
                ShellInfo {
                    app_name: "Drifting Next",
                    bundle_id: "cc.drifting.next.dev",
                    version: "0.2.0-dev",
                    url_scheme: "drifting-next-dev",
                    forced_appearance: Some(Appearance::Light),
                },
                Services::default(),
                SettingsFile::in_memory(),
                cx,
            );
            dr_view_page::init(cx);
        }
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

/// Runs until the module has been read and nothing is left to store.
fn settle(view: &Entity<CustomModule>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if view.read_with(cx, |v, _| v.data().is_some() && v.is_settled()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the custom module did not settle"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Runs until `done` holds for what the book reads, at most ten seconds.
fn until(e: &Env, cx: &mut VisualTestContext, what: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        let r = read(e);
        if done(&r) {
            return r;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {r}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The module as the entry page holds it: inside the page's 32 px margins.
struct Paper(Entity<CustomModule>);

impl gpui::Render for Paper {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _};
        gpui::div().size_full().px(px(32.0)).child(self.0.clone())
    }
}

fn open(cx: &mut TestAppContext, e: &Env) -> (Entity<CustomModule>, VisualTestContext) {
    cx.executor().allow_parking();
    shell_init(cx);
    let book = Rc::new(Book::load(&e.ws, &e.book).unwrap());
    let module = book
        .v3()
        .unwrap()
        .template_of(&e.entry)
        .unwrap()
        .modules
        .iter()
        .find(|m| m.id == "mod-c")
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
    // On the page's paper: the module with the page's margins round it
    // (an item's grip and 删除 stand in them).
    let window = cx.add_window(|window, cx| {
        let module = cx.new(|cx| CustomModule::new(host, window, cx));
        Paper(module)
    });
    let view = window.root(cx).unwrap().read_with(cx, |p, _| p.0.clone());
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(900.0), px(1100.0)));
    settle(&view, &mut vcx);
    (view, vcx)
}

/// Where `selector` was drawn last (GPUI keeps selectors as `'static`
/// strings; the tests' are made from ids, and kept for the test's life).
fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<gpui::Bounds<gpui::Pixels>> {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    cx.debug_bounds(selector)
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let at = bounds(cx, selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"))
        .center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
}

/// The pointer on a module's title row (where its fill button shows).
fn hover_title(cx: &mut VisualTestContext, module: &str) {
    draw(cx);
    let section = bounds(cx, &format!("v3-section-{module}"))
        .unwrap_or_else(|| panic!("the section of {module} is drawn"));
    let at = section.origin + point(px(40.0), px(20.0));
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
}

fn hover(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let at = bounds(cx, selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"))
        .center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
}

/// Types `text` into the field of the value at `key` (as `custom-field-…`
/// names it), then leaves it with `leave` (a key, or a blur).
fn type_into(cx: &mut VisualTestContext, key: &str, text: &str, leave: Option<&str>) {
    click(cx, &format!("custom-field-{key}"));
    cx.simulate_input(text);
    draw(cx);
    match leave {
        Some(keys) => cx.simulate_keystrokes(keys),
        None => cx.update(|window, cx| window.blur(cx)),
    }
    draw(cx);
}

/// Opens the choice list on the value at `key` and picks row `row`.
fn pick(cx: &mut VisualTestContext, key: &str, row: usize) {
    click(cx, &format!("custom-value-{key}"));
    pick_row(cx, row);
}

/// Picks row `row` of the open choice list, scrolled into view first (a
/// list taller than its 280 px scrolls, as a select's does).
fn pick_row(cx: &mut VisualTestContext, row: usize) {
    let selector = format!("custom-menu-row-{row}");
    for _ in 0..40 {
        draw(cx);
        let list = bounds(cx, "custom-menu-scroll").expect("the choice list is open");
        let b = bounds(cx, &selector).unwrap_or_else(|| panic!("{selector} is in the list"));
        let dy = if b.bottom() > list.bottom() {
            list.bottom() - b.bottom()
        } else if b.top() < list.top() {
            list.top() - b.top()
        } else {
            break;
        };
        cx.simulate_mouse_move(list.center(), None, Modifiers::none());
        cx.simulate_event(gpui::ScrollEvent {
            position: list.center(),
            delta: gpui::ScrollDelta::Pixels(point(px(0.0), dy)),
            ..Default::default()
        });
    }
    click(cx, &selector);
}

fn values(r: &Value) -> &Value {
    &r["values"]
}

#[gpui::test]
fn every_kind_of_block_is_filled_in_place_and_reads_back(cx: &mut TestAppContext) {
    let e = env(MAGIC);
    let png = e.dir.path().join("seal.png");
    std::fs::write(&png, dr_testkit::media::png(8, 8)).unwrap();
    let asset = dr_view_material::import::import_path(&e.ws, &e.book, None, &png)
        .unwrap()
        .material;
    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    assert_eq!(values(&read(&e)), &json!({}));

    // 一段字: stored when the field is left.
    type_into(cx, "rules", "只在起雾的夜里有效。", None);
    let r = until(&e, cx, "rules", |r| !values(r)["rules"].is_null());
    assert_eq!(
        values(&r)["rules"],
        json!({"type": "long_text", "value": "只在起雾的夜里有效。"})
    );
    // 一行字 inside a group: Enter stores it.
    type_into(cx, "price", "一段记忆", Some("enter"));
    let r = until(&e, cx, "price", |r| !values(r)["price"].is_null());
    assert_eq!(values(&r)["price"]["value"], "一段记忆");

    // 单选, shown as words: picked from its list (row 0 is 「未设置」).
    pick(cx, "school", 2);
    let r = until(&e, cx, "school", |r| !values(r)["school"].is_null());
    assert_eq!(
        values(&r)["school"],
        json!({"type": "select", "value": "林"})
    );
    // 单选, shown as a mark.
    pick(cx, "risk", 3);
    let r = until(&e, cx, "risk", |r| !values(r)["risk"].is_null());
    assert_eq!(values(&r)["risk"]["value"], "高");
    // 「未设置」 clears it.
    pick(cx, "risk", 0);
    until(&e, cx, "risk cleared", |r| values(r)["risk"].is_null());

    // 勾选: a press turns it.
    click(cx, "custom-value-forbidden");
    let r = until(&e, cx, "forbidden", |r| !values(r)["forbidden"].is_null());
    assert_eq!(
        values(&r)["forbidden"],
        json!({"type": "toggle", "value": true})
    );
    click(cx, "custom-value-forbidden");
    until(&e, cx, "forbidden off", |r| {
        values(r)["forbidden"]["value"] == false
    });

    // A number shown as dots is typed into while it is pressed.
    click(cx, "custom-value-power");
    settle(&view, cx);
    cx.simulate_input("4");
    cx.simulate_keystrokes("enter");
    let r = until(&e, cx, "power", |r| !values(r)["power"].is_null());
    assert_eq!(values(&r)["power"], json!({"type": "number", "value": 4.0}));
    draw(cx);
    assert!(
        cx.debug_bounds("custom-field-power").is_none(),
        "the dots are back once it is stored"
    );
    // Words that are no number are not stored.
    click(cx, "custom-value-power");
    settle(&view, cx);
    cx.simulate_input("很强");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(values(&read(&e))["power"]["value"], 4.0);
    assert!(
        cx.debug_bounds("custom-field-power").is_some(),
        "the field stays while what is in it is no number"
    );
    // Esc puts the stored number back, and the dots.
    cx.simulate_keystrokes("escape");
    settle(&view, cx);
    assert!(cx.debug_bounds("custom-field-power").is_none());
    assert_eq!(values(&read(&e))["power"]["value"], 4.0);

    // 图片: one of the book's images.
    pick(cx, "seal", 1);
    let r = until(&e, cx, "seal", |r| !values(r)["seal"].is_null());
    assert_eq!(values(&r)["seal"], json!({"type": "image", "value": asset}));

    // 铺满 lays out 多选 and 日期 too.
    cx.update(|_, cx| {
        cx.set_global(FilledModule(Some(ModuleFill {
            entry: e.entry.clone(),
            module: "mod-c".into(),
        })))
    });
    draw(cx);
    pick(cx, "schools", 0);
    until(&e, cx, "schools", |r| !values(r)["schools"].is_null());
    pick(cx, "schools", 3);
    let r = until(&e, cx, "two schools", |r| {
        values(r)["schools"]["value"].as_array().map(Vec::len) == Some(2)
    });
    assert_eq!(values(&r)["schools"]["value"], json!(["风", "山"]));
    type_into(cx, "since", "2026-11-24", Some("enter"));
    let r = until(&e, cx, "since", |r| !values(r)["since"].is_null());
    assert_eq!(
        values(&r)["since"],
        json!({"type": "date", "value": "2026-11-24"})
    );
    // The words typed earlier are the field's words now.
    let rules = view.read_with(cx, |v, cx| v.input(&[], "rules").unwrap().read(cx).text());
    assert_eq!(rules, "只在起雾的夜里有效。");
    settle(&view, cx);
}

#[gpui::test]
fn list_items_are_added_taken_away_and_moved_each_one_step_of_undo(cx: &mut TestAppContext) {
    let e = env(CHRONOLOGY);
    let other = call(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "title": "北渡", "template": "tpl-mod"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    let items = |r: &Value, list: &str| {
        r["values"][list]["value"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };

    click(cx, "custom-add-eras");
    let r = until(&e, cx, "an era", |r| items(r, "eras").len() == 1);
    let era = items(&r, "eras")[0]["id"].as_str().unwrap().to_owned();
    settle(&view, cx);
    type_into(cx, &format!("eras:{era}/era"), "雾纪", Some("enter"));
    until(&e, cx, "the era's name", |r| {
        items(r, "eras")[0]["values"]["era"]["value"] == "雾纪"
    });

    // A list inside the item's list.
    for n in 1..=3 {
        click(cx, &format!("custom-add-eras:{era}/events"));
        until(&e, cx, "an event", |r| {
            items(r, "eras")[0]["values"]["events"]["value"]
                .as_array()
                .map(Vec::len)
                == Some(n)
        });
        settle(&view, cx);
    }
    let events = |r: &Value| -> Vec<String> {
        items(r, "eras")[0]["values"]["events"]["value"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_owned())
            .collect()
    };
    let order = events(&read(&e));
    for (i, id) in order.iter().enumerate() {
        type_into(
            cx,
            &format!("eras:{era}/events:{id}/year"),
            &format!("{}", (i + 1) * 10),
            Some("enter"),
        );
    }
    until(&e, cx, "three years", |r| {
        items(r, "eras")[0]["values"]["events"]["value"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| !i["values"]["year"].is_null())
    });
    // 条目: the entries of the book, picked (row 0 is 「未设置」).
    let first = &order[0];
    click(cx, &format!("custom-value-eras:{era}/events:{first}/where"));
    let row = {
        let v3 = Book::load(&e.ws, &e.book).unwrap();
        let live: Vec<String> = v3
            .v3()
            .unwrap()
            .entries
            .iter()
            .filter(|x| x.deleted_at.is_none())
            .map(|x| x.id.clone())
            .collect();
        1 + live.iter().position(|x| *x == other).unwrap()
    };
    pick_row(cx, row);
    let r = until(&e, cx, "where", |r| {
        !items(r, "eras")[0]["values"]["events"]["value"][0]["values"]["where"].is_null()
    });
    assert_eq!(
        items(&r, "eras")[0]["values"]["events"]["value"][0]["values"]["where"],
        json!({"type": "entry", "value": [other]})
    );

    // Moved: the last event first; its values go with it.
    let path = vec![dr_model::custom_module::values::ItemStep {
        list: "eras".into(),
        item: era.clone(),
    }];
    view.update(cx, |v, cx| v.move_item(path, "events", &order[2], 0, cx));
    let r = until(&e, cx, "the move", |r| events(r)[0] == order[2]);
    assert_eq!(
        events(&r),
        [order[2].clone(), order[0].clone(), order[1].clone()]
    );
    assert_eq!(
        items(&r, "eras")[0]["values"]["events"]["value"][0]["values"]["year"]["value"],
        30.0
    );
    // ⌘Z puts it back, in one step.
    e.ws.undo(&Actor::User).unwrap().unwrap();
    let r = until(&e, cx, "the move undone", |r| events(r)[0] == order[0]);
    assert_eq!(events(&r), order);

    // Taken away from where it is (its button shows while the pointer is on it).
    let second = order[1].clone();
    hover(cx, &format!("custom-item-{second}"));
    click(cx, &format!("custom-item-remove-{second}"));
    let r = until(&e, cx, "the removal", |r| events(r).len() == 2);
    assert!(!events(&r).contains(&second));
    e.ws.undo(&Actor::User).unwrap().unwrap();
    let r = until(&e, cx, "the removal undone", |r| events(r).len() == 3);
    assert_eq!(events(&r), order);
    assert_eq!(
        items(&r, "eras")[0]["values"]["events"]["value"][1]["values"]["year"]["value"],
        20.0,
        "what it kept comes back with it"
    );
    settle(&view, cx);
}

/// 人物弧光: items side by side with arrows between them, a select drawn as
/// a mark and as words (one choice list for both), several lines of words
/// in an item, a number as dots outside the list.
#[gpui::test]
fn a_row_of_items_with_marks_and_words_is_filled_in(cx: &mut TestAppContext) {
    let e = env(ARC);
    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    type_into(cx, "want", "找回那块怀表", Some("enter"));
    until(&e, cx, "want", |r| {
        r["values"]["want"]["value"] == "找回那块怀表"
    });
    click(cx, "custom-add-turns");
    let r = until(&e, cx, "a turn", |r| {
        r["values"]["turns"]["value"].as_array().map(Vec::len) == Some(1)
    });
    let turn = r["values"]["turns"]["value"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    settle(&view, cx);
    // 起点、动摇、转折、新我: row 0 is 「未设置」.
    pick(cx, &format!("turns:{turn}/stage"), 3);
    until(&e, cx, "the stage", |r| {
        r["values"]["turns"]["value"][0]["values"]["stage"]["value"] == "转折"
    });
    type_into(
        cx,
        &format!("turns:{turn}/what"),
        "在钟楼下认出了父亲",
        None,
    );
    let r = until(&e, cx, "what happened", |r| {
        !r["values"]["turns"]["value"][0]["values"]["what"].is_null()
    });
    assert_eq!(
        r["values"]["turns"]["value"][0]["values"]["what"],
        json!({"type": "long_text", "value": "在钟楼下认出了父亲"})
    );
    click(cx, "custom-value-resolve");
    settle(&view, cx);
    cx.simulate_input("3");
    cx.simulate_keystrokes("enter");
    until(&e, cx, "resolve", |r| {
        r["values"]["resolve"]["value"] == 3.0
    });
    settle(&view, cx);
}

/// A copy this build cannot read: its name alone, nothing to fill in, the
/// values untouched byte for byte.
#[gpui::test]
fn a_broken_copy_is_its_name_and_its_values_stay(cx: &mut TestAppContext) {
    let e = env(FORESHADOWING);
    let target = json!({"book": e.book, "entry": e.entry, "module": "mod-c"});
    let mut add = target.clone();
    add["list"] = json!("items");
    let item = call(&e.ws, "module.add_custom_item", add)["item"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut set = target.clone();
    set["path"] = json!([{"list": "items", "item": item}]);
    set["block"] = json!("line");
    set["value"] = json!("旧照片");
    call(&e.ws, "module.set_custom_value", set);
    // A newer build's copy arrives from another device, and my modules no
    // longer have it (CM1's `a_broken_copy_reads_as_broken…`).
    call(&e.ws, "custom_module.remove", json!({"id": e.module}));
    let raw =
        e.ws.library()
            .load_copy(&format!("book:{}", e.book))
            .unwrap();
    let before = raw.oplog_vv();
    raw.set_peer_id(4242).unwrap();
    let newer = FORESHADOWING.replace("\"formatVersion\": 1", "\"formatVersion\": 3");
    let record: std::collections::HashMap<String, loro::LoroValue> = [
        ("value".to_owned(), loro::LoroValue::from(newer.as_str())),
        ("source".to_owned(), loro::LoroValue::from("library")),
    ]
    .into_iter()
    .collect();
    raw.get_map("modules")
        .insert(&e.module, loro::LoroValue::from(record))
        .unwrap();
    raw.commit();
    let bytes = raw.export(ExportMode::updates(&before)).unwrap();
    e.ws.import_remote(&format!("book:{}", e.book), None, bytes, &Actor::Sync)
        .unwrap();
    // The whole book document, as it is stored.
    let entries = |e: &Env| {
        let doc =
            e.ws.library()
                .load_copy(&format!("book:{}", e.book))
                .unwrap();
        serde_json::to_string(&doc.get_deep_value()).unwrap()
    };
    let stored = entries(&e);
    assert!(stored.contains("旧照片"));

    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    assert_eq!(view.read_with(cx, |v, _| v.is_broken()), Some(true));
    draw(cx);
    assert!(cx.debug_bounds("module-placeholder").is_some());
    assert!(
        bounds(cx, &format!("custom-field-items:{item}/line")).is_none(),
        "nothing to fill in"
    );
    assert!(cx.debug_bounds("custom-add-items").is_none());
    assert_eq!(entries(&e), stored, "the values are as they were");
}

/// My module changed while its entry's page is open: the page takes the new
/// copy at once, every value stays, and the words being typed stay.
#[gpui::test]
fn a_replaced_copy_redraws_at_once_and_keeps_values_and_typing(cx: &mut TestAppContext) {
    let e = env(FORESHADOWING);
    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    click(cx, "custom-add-items");
    let r = until(&e, cx, "an item", |r| {
        r["values"]["items"]["value"].as_array().map(Vec::len) == Some(1)
    });
    let item = r["values"]["items"]["value"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    settle(&view, cx);
    type_into(
        cx,
        &format!("items:{item}/line"),
        "墙上的旧照片",
        Some("enter"),
    );
    until(&e, cx, "the line", |r| {
        r["values"]["items"]["value"][0]["values"]["line"]["value"] == "墙上的旧照片"
    });
    pick(cx, &format!("items:{item}/st"), 2);
    until(&e, cx, "the state", |r| {
        r["values"]["items"]["value"][0]["values"]["st"]["value"] == "提过"
    });
    // Typing, not stored yet.
    click(cx, &format!("custom-field-items:{item}/line"));
    cx.simulate_input("，少了一个人");
    draw(cx);

    // In the workbench (or on another device): a block 「提过在」 added to
    // each item and drawn after the line.
    let mut changed: Value = serde_json::from_str(FORESHADOWING).unwrap();
    changed["blocks"][0]["blocks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "seen", "type": "entry", "name": "提过在"}));
    changed["look"]["block"]["item"]["kids"]
        .as_array_mut()
        .unwrap()
        .push(json!({"value": "seen", "size": "small"}));
    call(
        &e.ws,
        "custom_module.update",
        json!({"id": e.module, "value": changed}),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        let has = view.read_with(cx, |v, _| {
            v.data()
                .and_then(|d| d.value.as_ref())
                .is_some_and(|m| m.block("seen").is_some())
        });
        if has {
            break;
        }
        assert!(Instant::now() < deadline, "the new copy was not drawn");
        std::thread::sleep(Duration::from_millis(5));
    }
    draw(cx);
    assert!(
        bounds(cx, &format!("custom-value-items:{item}/seen")).is_some(),
        "the new block is on the page"
    );
    let r = read(&e);
    assert_eq!(
        r["values"]["items"]["value"][0]["values"]["st"]["value"],
        "提过"
    );
    let typed = view.read_with(cx, |v, cx| {
        v.input(&[("items", item.as_str())], "line")
            .unwrap()
            .read(cx)
            .text()
    });
    assert_eq!(
        typed, "墙上的旧照片，少了一个人",
        "what is being typed stays"
    );
    cx.simulate_keystrokes("enter");
    until(&e, cx, "the typed words", |r| {
        r["values"]["items"]["value"][0]["values"]["line"]["value"] == "墙上的旧照片，少了一个人"
    });
    settle(&view, cx);
}

fn workspace<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
) -> (Entity<dr_shell::Workspace>, &'a mut VisualTestContext) {
    workspace_with(cx, e, true)
}

/// A bottom panel with nothing in it (the timeline's place).
struct Blank;

impl gpui::Render for Blank {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        gpui::div()
    }
}

/// The shell's workspace on `e`'s book, with a blank timeline under the
/// paper; `reduce`: the reduced-motion setting (transitions land at once).
fn workspace_with<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    reduce: bool,
) -> (Entity<dr_shell::Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let lib = e.ws.clone();
    cx.update(|cx| {
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(Appearance::Light),
            },
            Services {
                deep_links: None,
                crash_reports: None,
                library: Some(lib),
                library_failure: None,
                book: Some(e.book.clone()),
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_view_page::init(cx);
        dr_shell::pages::add_v3_bottom_panel(
            cx,
            dr_shell::pages::BottomPane::Timeline,
            |_, _, cx| Some(dr_shell::pages::BottomPanel::new(cx.new(|_| Blank))),
        );
        dr_shell::Settings::update(cx, |f| f.set(registry::REDUCE_MOTION, json!(reduce), None))
            .unwrap();
    });
    let (view, cx) = cx.add_window_view(dr_shell::Workspace::new);
    cx.simulate_resize(size(px(1440.0), px(900.0)));
    (view, cx)
}

/// The module fills the middle column from its own button: the page is its
/// head and that module, at the column's widest; Esc leaves, and so does the
/// button.
#[gpui::test]
fn the_module_fills_the_middle_column_and_esc_leaves(cx: &mut TestAppContext) {
    let e = env(CHRONOLOGY);
    let (view, cx) = workspace(cx, &e);
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.book.v3().is_none()) {
        assert!(Instant::now() < deadline, "the book did not open");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    let target = Target::Entry {
        id: e.entry.parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if cx.debug_bounds("custom-module").is_some()
            && cx.debug_bounds("v3-section-mod-text").is_some()
        {
            break;
        }
        assert!(Instant::now() < deadline, "the entry page did not show");
        std::thread::sleep(Duration::from_millis(5));
    }
    let paper = |cx: &mut VisualTestContext| {
        cx.debug_bounds("custom-module")
            .map(|b| f32::from(b.size.width))
            .unwrap_or(0.0)
    };
    let narrow = paper(cx);
    hover_title(cx, "mod-c");
    click(cx, "custom-module-fill");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.filled_module().cloned()),
        Some(ModuleFill {
            entry: e.entry.clone(),
            module: "mod-c".into()
        })
    );
    // Under reduced motion the paper lands at once (CR).
    assert_eq!(view.read_with(cx, |ws, _| ws.module_fill_progress()), 1.0);
    draw(cx);
    assert!(
        cx.debug_bounds("v3-section-mod-text").is_none(),
        "filled, the page is the module alone"
    );
    assert!(paper(cx) > narrow + 100.0, "{narrow} → {}", paper(cx));
    assert!(
        cx.debug_bounds("bottom-panel-grip").is_none(),
        "the bottom panel is put away"
    );
    // Esc leaves.
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.filled_module().cloned()),
        None
    );
    assert_eq!(view.read_with(cx, |ws, _| ws.module_fill_progress()), 0.0);
    assert_eq!(paper(cx), narrow, "back at the page's width at once");
    assert!(cx.debug_bounds("v3-section-mod-text").is_some());
    // So does the button, pressed again; and a panel's fill takes over.
    hover_title(cx, "mod-c");
    click(cx, "custom-module-fill");
    assert!(view.read_with(cx, |ws, _| ws.filled_module().is_some()));
    click(cx, "custom-module-fill");
    assert!(view.read_with(cx, |ws, _| ws.filled_module().is_none()));
    hover_title(cx, "mod-c");
    click(cx, "custom-module-fill");
    view.update_in(cx, |ws, window, cx| {
        assert!(ws.enter_fill(dr_shell::workspace::FillPlace::Bottom, window, cx));
        assert!(ws.filled_module().is_none(), "one fill at a time");
    });
    let _ = point(px(0.0), px(0.0));
}

/// The module's fill opens and closes as a panel's does (CR, the shell's
/// `motion::STRUCTURAL`, 420 ms): the paper widens over it and narrows back
/// over it as the module leaves, the bottom panel put away while it fills.
/// The clock is held still at each moment looked at.
#[gpui::test]
fn the_module_fill_opens_and_closes_over_the_panels_motion(cx: &mut TestAppContext) {
    let e = env(CHRONOLOGY);
    let (view, cx) = workspace_with(cx, &e, false);
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.book.v3().is_none()) {
        assert!(Instant::now() < deadline, "the book did not open");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    let target = Target::Entry {
        id: e.entry.parse().unwrap(),
        module: None,
    };
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if cx.debug_bounds("custom-module").is_some()
            && cx.debug_bounds("v3-section-mod-text").is_some()
        {
            break;
        }
        assert!(Instant::now() < deadline, "the entry page did not show");
        std::thread::sleep(Duration::from_millis(5));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, cx| ws.bottom_pane(cx))
        != Some(dr_shell::pages::BottomPane::Timeline)
        || cx.debug_bounds("bottom-panel-grip").is_none()
    {
        assert!(Instant::now() < deadline, "the timeline did not show");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    // The page turned in (180 ms) and the panel slid up before the clock
    // is held.
    std::thread::sleep(Duration::from_millis(600));
    draw(cx);
    let paper = |cx: &mut VisualTestContext| {
        cx.debug_bounds("custom-module")
            .map(|b| f32::from(b.size.width))
            .expect("the module is drawn")
    };
    // The bottom panel's top edge (its grip), while it shows.
    let panel_top = |cx: &mut VisualTestContext| {
        cx.debug_bounds("bottom-panel-grip")
            .map(|b| f32::from(b.top()))
    };
    let progress =
        |cx: &mut VisualTestContext| view.read_with(cx, |ws, _| ws.module_fill_progress());
    let narrow = paper(cx);
    let resting = panel_top(cx).expect("the timeline shows");
    let at = |t: Instant, ms: u64| t + Duration::from_millis(ms);

    let opened = Instant::now();
    dr_ui::anim::freeze(Some(opened));
    hover_title(cx, "mod-c");
    click(cx, "custom-module-fill");
    assert!(view.read_with(cx, |ws, _| ws.filled_module().is_some()));
    assert_eq!(progress(cx), 0.0, "the fill starts from the page's width");
    assert!(
        view.read_with(cx, |ws, cx| ws.bottom_pane(cx)).is_none(),
        "the bottom panel is put away while the module fills"
    );
    dr_ui::anim::freeze(Some(at(opened, 210)));
    draw(cx);
    let half_open = paper(cx);
    let t = progress(cx);
    assert!(t > 0.0 && t < 1.0, "half-way through the motion: {t}");
    assert!(half_open > narrow, "{narrow} → {half_open}");
    let sliding = panel_top(cx).expect("the timeline is sliding away");
    assert!(
        sliding > resting,
        "the timeline slides down: {resting} → {sliding}"
    );
    dr_ui::anim::freeze(Some(at(opened, 420)));
    draw(cx);
    let wide = paper(cx);
    assert_eq!(progress(cx), 1.0, "open after 420 ms");
    assert!(wide > half_open, "{half_open} → {wide}");
    assert!(wide > narrow + 100.0, "{narrow} → {wide}");
    assert!(panel_top(cx).is_none(), "the timeline is away");
    assert!(
        cx.debug_bounds("v3-section-mod-text").is_none(),
        "filled, the page is the module alone"
    );

    // Esc: the page has all its modules again at once, in a paper that
    // narrows back over the same motion, and the timeline slides back.
    let closed = at(opened, 1000);
    dr_ui::anim::freeze(Some(closed));
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(view.read_with(cx, |ws, _| ws.filled_module().is_none()));
    assert_eq!(progress(cx), 1.0, "the close starts from the widest");
    assert!(cx.debug_bounds("v3-section-mod-text").is_some());
    dr_ui::anim::freeze(Some(at(closed, 210)));
    draw(cx);
    let half_closed = paper(cx);
    let t = progress(cx);
    assert!(t > 0.0 && t < 1.0, "half-way back: {t}");
    assert!(
        half_closed > narrow && half_closed < wide,
        "{wide} → {half_closed} → {narrow}"
    );
    let rising = panel_top(cx).expect("the timeline is sliding back");
    assert!(
        rising > resting,
        "not up yet: {rising} (rests at {resting})"
    );
    dr_ui::anim::freeze(Some(at(closed, 420)));
    draw(cx);
    assert_eq!(progress(cx), 0.0, "closed after 420 ms");
    assert_eq!(paper(cx), narrow, "back at the page's width");
    assert_eq!(panel_top(cx), Some(resting), "the timeline is back");
    dr_ui::anim::freeze(None);
}

/// An entry's modules on its page and in its name's hover card come in the
/// template's order, the order they were given in, built-in and custom
/// together (CR): not in the order of their ids.
#[gpui::test]
fn the_entry_page_draws_modules_in_the_order_the_template_gives(cx: &mut TestAppContext) {
    let base = env(FORESHADOWING);
    let magic = call(
        &base.ws,
        "custom_module.create",
        json!({"value": serde_json::from_str::<Value>(MAGIC).unwrap()}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &base.ws,
        "entry_template.put",
        json!({"book": base.book, "template": {
            "id": "tpl-order", "name": "排序", "modules": [
                {"id": "z-fore", "kind": "custom", "name": "伏笔追踪", "config": {"module": base.module}},
                {"id": "m-text", "kind": "prose", "name": "正文"},
                {"id": "b-magic", "kind": "custom", "name": "魔法规则卡", "config": {"module": magic}},
                {"id": "a-facts", "kind": "fields", "name": "字段"}
            ]
        }}),
    );
    let entry = call(
        &base.ws,
        "entry.create",
        json!({"book": base.book, "title": "排序", "template": "tpl-order"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let e = Env { entry, ..base };
    let given = ["z-fore", "m-text", "b-magic", "a-facts"];

    let link = dr_text::autolink::LinkTarget {
        kind: dr_model::kind::EntityKind::Entry,
        id: e.entry.clone(),
    };
    let facts = dr_editor::link_card::card_facts(&e.ws, &e.book, &link).expect("a card");
    let lines: Vec<&str> = facts.lines.iter().map(|l| l.module.as_str()).collect();
    assert_eq!(lines, ["z-fore", "b-magic"], "the hover card's lines");

    let (view, cx) = workspace(cx, &e);
    let deadline = Instant::now() + Duration::from_secs(10);
    while view.read_with(cx, |ws, _| ws.book.v3().is_none()) {
        assert!(Instant::now() < deadline, "the book did not open");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    view.update(cx, |ws, cx| {
        ws.open(
            Target::Entry {
                id: e.entry.parse().unwrap(),
                module: None,
            },
            Open::KEEP,
            cx,
        )
    });
    let sections = |cx: &mut VisualTestContext| -> Vec<String> {
        view.read_with(cx, |ws, cx| {
            let page = ws
                .nav
                .current()
                .and_then(|t| ws.editors.get(&t.key()))
                .and_then(|p| p.v3.as_ref())
                .map(|p| p.read(cx).state());
            page.map(|state| {
                state["sections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|s| s["id"].as_str())
                    .filter(|id| given.contains(id))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
        })
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while sections(cx).len() < given.len() {
        assert!(Instant::now() < deadline, "the entry page did not show");
        draw(cx);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(sections(cx), given, "the page's modules");
    // Drawn top to bottom in that order.
    let tops: Vec<f32> = given
        .iter()
        .map(|id| {
            f32::from(
                bounds(cx, &format!("v3-section-{id}"))
                    .unwrap_or_else(|| panic!("the section of {id} is drawn"))
                    .top(),
            )
        })
        .collect();
    assert!(tops.windows(2).all(|w| w[0] < w[1]), "{tops:?}");
}

/// An entry name's hover card: under the synopsis, one 一行 for each custom
/// module whose copy can be read, with the entry's values.
#[gpui::test]
fn an_entry_names_hover_card_has_the_modules_line(cx: &mut TestAppContext) {
    let e = env(FORESHADOWING);
    let target = json!({"book": e.book, "entry": e.entry, "module": "mod-c"});
    for _ in 0..3 {
        let mut add = target.clone();
        add["list"] = json!("items");
        call(&e.ws, "module.add_custom_item", add);
    }
    let link = dr_text::autolink::LinkTarget {
        kind: dr_model::kind::EntityKind::Entry,
        id: e.entry.clone(),
    };
    let facts = dr_editor::link_card::card_facts(&e.ws, &e.book, &link).expect("a card");
    assert_eq!(facts.lines.len(), 1);
    let line = &facts.lines[0];
    assert_eq!(line.module, "mod-c");
    assert_eq!(line.values.lists["items"].len(), 3);
    struct Zh;
    impl dr_view_module_look::Words for Zh {
        fn count_of(&self, count: usize, list: &str) -> String {
            format!("{count} 个{list}")
        }
    }
    let laid = dr_view_module_look::plan::plan(
        &line.value,
        &line.values,
        dr_model::custom_module::LookSize::Line,
        &Zh,
    );
    let count = laid.root.values()[0].clone();
    assert_eq!(count.content, dr_view_module_look::Content::Count(3));
    assert_eq!(count.suffix.as_deref(), Some(" 处伏笔"));

    // The card draws it.
    shell_init(cx);
    struct Card(dr_editor::link_card::CardFacts);
    impl gpui::Render for Card {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            use gpui::{InteractiveElement as _, ParentElement as _};
            gpui::div()
                .debug_selector(|| "card".into())
                .child(dr_editor::link_card::card_element(&self.0))
        }
    }
    let (_, vcx) = cx.add_window_view(move |_, _| Card(facts));
    draw(vcx);
    assert!(vcx.debug_bounds("card").is_some());
    let drawn = vcx
        .debug_bounds("module-line")
        .expect("the module's line is in the card");
    assert!(drawn.size.height > px(0.0));
}

/// An automatic 一行's count in the App's nine languages (CR): where the
/// author's name cannot follow the number (English and the like) it is
/// 「伏笔: 3」; Chinese, Japanese and Korean say it as before.
#[gpui::test]
fn an_automatic_lines_count_is_said_name_then_number_where_needed(cx: &mut TestAppContext) {
    use dr_i18n::Locale;
    use dr_view_module_look::{AppWords, Words as _};
    shell_init(cx);
    let said = [
        (Locale::ZhCn, "3 个伏笔"),
        (Locale::ZhTw, "3 個伏笔"),
        (Locale::Ja, "伏笔 3 件"),
        (Locale::Ko, "伏笔 3개"),
        (Locale::En, "伏笔: 3"),
        (Locale::De, "伏笔: 3"),
        (Locale::Es, "伏笔: 3"),
        (Locale::PtBr, "伏笔: 3"),
        (Locale::Fr, "伏笔 : 3"),
    ];
    assert_eq!(said.len(), Locale::ALL.len(), "every language is looked at");
    for (locale, words) in said {
        cx.update(|cx| {
            dr_shell::strings::Strings::install(locale, cx);
            assert_eq!(AppWords(cx).count_of(3, "伏笔"), words, "{}", locale.code());
        });
    }
}

/// Words typed into one field are stored when the author presses another
/// (the field is left by the press, not by Enter or a blur of the window).
#[gpui::test]
fn typed_words_are_stored_when_another_field_is_pressed(cx: &mut TestAppContext) {
    let e = env(MAGIC);
    let (view, mut cx) = open(cx, &e);
    let cx = &mut cx;
    click(cx, "custom-field-rules");
    for c in ["只", "在", "夜", "里"] {
        cx.simulate_keystrokes(c);
    }
    draw(cx);
    let typed = view.read_with(cx, |v, cx| v.input(&[], "rules").unwrap().read(cx).text());
    assert_eq!(typed, "只在夜里");
    click(cx, "custom-field-price");
    let r = until(&e, cx, "rules", |r| !values(r)["rules"].is_null());
    assert_eq!(
        values(&r)["rules"],
        json!({"type": "long_text", "value": "只在夜里"})
    );
    settle(&view, cx);
}
