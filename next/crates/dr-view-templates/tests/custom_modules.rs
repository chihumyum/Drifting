//! CM3 in the entry template editor (`custom-modules.md` §7, §9; 原型第三页):
//! the 「添加模块」 menu lists my modules (not those the template has) and
//! 「新建模块…」; a row drawing one of my modules says 「我的模块」 and 「改」
//! (its workbench), one that came with someone else's template or book says
//! 「模块」 and 「存进我的模块」 (a new id in my modules, the template uses it).
//! The modules are dr-testkit's samples.

use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    nav::{Open, Target},
    v3::{self, Rendered},
};
use dr_view_templates::TemplateEditor;
use dr_workspace::{Actor, Workspace};
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, Render, TestAppContext,
    VisualTestContext, Window, div, px, size,
};
use serde_json::{Value, json};

fn call(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn sample(name: &str) -> Value {
    let raw = dr_testkit::samples::MODULE_FILES
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap()
        .1;
    serde_json::from_str(raw).unwrap()
}

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
    template: String,
    fore: String,
    arc: String,
    orphan: String,
}

/// A tiny book whose first template draws 伏笔追踪 (`mod-fore`, mine) and a
/// module that came from elsewhere (`mod-orphan`: its copy is in the book,
/// my modules no longer have it); 人物弧光 is mine and not in the template.
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
    let fore = call(
        &ws,
        "custom_module.create",
        json!({"value": sample("foreshadowing")}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let arc = call(
        &ws,
        "custom_module.create",
        json!({"value": sample("character-arc")}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let orphan = call(
        &ws,
        "custom_module.create",
        json!({"value": sample("magic-rule")}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let template = call(&ws, "entry_template.list", json!({"book": book}))[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    for (mid, module) in [("mod-fore", &fore), ("mod-orphan", &orphan)] {
        call(
            &ws,
            "entry_template.put_module",
            json!({"book": book, "template": template, "module": {
                "id": mid, "kind": "custom", "name": mid, "config": {"module": module}
            }}),
        );
    }
    call(&ws, "custom_module.remove", json!({"id": orphan}));
    Env {
        _dir: dir,
        ws,
        book,
        template,
        fore,
        arc,
        orphan,
    }
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn open<'a>(cx: &'a mut TestAppContext, e: &Env) -> (Entity<Shell>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        let _ = dr_ui::init(cx);
        dr_shell::init(
            ShellInfo {
                app_name: "Drifting Next",
                bundle_id: "cc.drifting.next.dev",
                version: "0.2.0-dev",
                url_scheme: "drifting-next-dev",
                forced_appearance: Some(dr_ui::Appearance::Light),
            },
            Services {
                library: Some(e.ws.clone()),
                book: Some(e.book.clone()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        dr_shell::Settings::update(cx, |f| {
            f.set(
                dr_shell::settings::registry::REDUCE_MOTION,
                serde_json::json!(true),
                None,
            )
        })
        .unwrap();
        for display in ["list", "board", "grid", "island"] {
            v3::add_level_display(cx, display, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        }
        v3::add_level_settings(cx, |_, _, cx| Rendered::new(cx.new(|_| DummyPart)));
        dr_view_templates::init(cx);
    });
    let (view, cx) = cx.add_window_view(Shell::new);
    cx.update(|window, _| window.activate_window());
    cx.simulate_resize(size(px(1600.0), px(1000.0)));
    (view, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<gpui::Bounds<gpui::Pixels>> {
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    cx.debug_bounds(selector)
}

fn until(cx: &mut VisualTestContext, what: &str, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    until(cx, selector, |cx| bounds(cx, selector).is_some());
    let at = bounds(cx, selector).unwrap().center();
    cx.simulate_mouse_move(at, None, Modifiers::none());
    draw(cx);
    cx.simulate_click(at, Modifiers::none());
    draw(cx);
}

fn editor(view: &Entity<Shell>, key: &str, cx: &mut VisualTestContext) -> Entity<TemplateEditor> {
    view.read_with(cx, |ws, _| {
        ws.editors[key]
            .module
            .as_ref()
            .expect("a module page")
            .view
            .clone()
            .downcast::<TemplateEditor>()
            .unwrap_or_else(|_| panic!("the template editor"))
    })
}

#[gpui::test]
fn the_editor_puts_in_my_modules_and_keeps_the_ones_from_elsewhere(cx: &mut TestAppContext) {
    let e = env();
    let (view, cx) = open(cx, &e);
    until(cx, "the book", |cx| {
        view.read_with(cx, |ws, _| ws.book.v3().is_some())
    });
    let target = Target::Template(e.template.parse().unwrap());
    let key = target.key();
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    until(cx, "the editor", |cx| {
        view.read_with(cx, |ws, _| ws.editors.contains_key(&key))
    });
    let ed = editor(&view, &key, cx);
    until(cx, "my modules", |cx| {
        ed.read_with(cx, |e, _| e.my_modules().is_some())
    });

    // Mine: 「改」; from elsewhere: 「存进我的模块」, no 「改」.
    assert!(bounds(cx, "k5-custom-edit-mod-fore").is_some());
    assert!(bounds(cx, "k5-custom-adopt-mod-fore").is_none());
    assert!(bounds(cx, "k5-custom-adopt-mod-orphan").is_some());
    assert!(bounds(cx, "k5-custom-edit-mod-orphan").is_none());

    // 「改」 opens the module's workbench, a pill of the project.
    click(cx, "k5-custom-edit-mod-fore");
    let fore = Target::Module(e.fore.parse().unwrap());
    assert_eq!(
        view.read_with(cx, |ws, _| ws.nav.current().cloned()),
        Some(fore)
    );
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    draw(cx);

    // The menu: my modules not in the template yet (人物弧光), then
    // 「新建模块…」.
    click(cx, "k5-add-module");
    assert!(bounds(cx, &format!("k5-pick-module-{}", e.arc)).is_some());
    assert!(bounds(cx, &format!("k5-pick-module-{}", e.fore)).is_none());
    assert!(bounds(cx, "k5-new-module").is_some());
    click(cx, &format!("k5-pick-module-{}", e.arc));
    let placed = ed
        .read_with(cx, |ed, _| {
            ed.draft()
                .modules
                .iter()
                .find(|m| m.config.module.as_deref() == Some(e.arc.as_str()))
                .cloned()
        })
        .expect("put into the draft");
    assert_eq!(placed.kind, "custom");
    click(cx, "k5-save");
    until(cx, "the template stored", |_| {
        let t = call(&e.ws, "entry_template.list", json!({"book": e.book}));
        t[0]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["config"]["module"] == json!(e.arc))
    });

    // 「存进我的模块」: a new module of mine, the template uses it.
    click(cx, "k5-custom-adopt-mod-orphan");
    let mut kept = String::new();
    until(cx, "the module kept", |_| {
        let t = call(&e.ws, "entry_template.list", json!({"book": e.book}));
        let now = t[0]["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == "mod-orphan")
            .and_then(|m| m["config"]["module"].as_str())
            .unwrap_or_default()
            .to_owned();
        now != e.orphan
    });
    let t = call(&e.ws, "entry_template.list", json!({"book": e.book}));
    for m in t[0]["modules"].as_array().unwrap() {
        if m["id"] == "mod-orphan" {
            kept = m["config"]["module"].as_str().unwrap().to_owned();
        }
    }
    let mine = call(&e.ws, "custom_module.list", json!({}));
    assert!(
        mine.as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(kept))
    );
    until(cx, "the row says mine", |cx| {
        bounds(cx, "k5-custom-edit-mod-orphan").is_some()
    });

    // 「新建模块…」: an empty module of mine, in the draft, in its workbench.
    let before = mine.as_array().unwrap().len();
    click(cx, "k5-add-module");
    click(cx, "k5-new-module");
    until(cx, "a new module", |_| {
        call(&e.ws, "custom_module.list", json!({}))
            .as_array()
            .unwrap()
            .len()
            == before + 1
    });
    let list = call(&e.ws, "custom_module.list", json!({}));
    let made = list[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(list[0]["blocks"], json!(0));
    until(cx, "its workbench", |cx| {
        view.read_with(cx, |ws, _| ws.nav.current().cloned())
            == Some(Target::Module(made.parse().unwrap()))
    });
    assert!(ed.read_with(cx, |ed, _| {
        ed.draft()
            .modules
            .iter()
            .any(|m| m.config.module.as_deref() == Some(made.as_str()))
    }));
}
