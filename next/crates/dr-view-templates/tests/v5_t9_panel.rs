//! T9 (`kernel-v5.md` §9): 「新建模板」 in the filled left column stores
//! nothing until the author changes something; from the left foot of a
//! column that does not fill it opens the stored template's full editor in
//! a new pill. The structure's floating panel is its own Esc layer: Esc in
//! a field shows what is stored again and closes the panel, never the
//! fill, and what the panel holds is never dropped silently.
use std::time::{Duration, Instant};

use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace as Shell,
    nav::Target,
    pages::PageViewHost,
    v3::{self, Rendered, template_structure::Structure},
    workspace::FillPlace,
};
use dr_view_templates::TemplateEditor;
use dr_workspace::Workspace;
use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, Modifiers, Render, TestAppContext,
    VisualTestContext, Window, div, px, size,
};

fn seed() -> (tempfile::TempDir, Workspace, String) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let made = dr_testkit::seed::generate_v3(
        dr_testkit::seed::Preset::Tiny,
        dr_testkit::seed::DEFAULT_SEED,
    )
    .unwrap();
    let id = made.books[0].book_id().to_string();
    made.write_to(&store).unwrap();
    store.close().unwrap();
    let ws = Workspace::open_dir(dir.path(), "0.2.0-dev").unwrap();
    (dir, ws, id)
}

struct DummyPart;
impl Render for DummyPart {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

fn open<'a>(
    cx: &'a mut TestAppContext,
    lib: &Workspace,
    id: &str,
) -> (Entity<Shell>, &'a mut VisualTestContext) {
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
                library: Some(lib.clone()),
                book: Some(id.to_owned()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
        dr_shell::strings::Strings::install(dr_i18n::Locale::ZhCn, cx);
        // Panels open and fill at once: the clicks land where they are drawn.
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

fn pump(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn wait(
    view: &Entity<Shell>,
    cx: &mut VisualTestContext,
    what: &str,
    done: impl Fn(&Shell, &App) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        pump(cx);
        if view.read_with(cx, |ws, cx| done(ws, cx)) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// A stored template, as the library lists it.
struct Stored {
    id: String,
    name: String,
    level: bool,
}

/// The library's own list: what is stored, not what a view holds.
fn stored(lib: &Workspace, id: &str) -> Vec<Stored> {
    let list = lib
        .call(
            &dr_workspace::Actor::User,
            "entry_template.list",
            serde_json::json!({ "book": id }),
        )
        .unwrap()["output"]
        .clone();
    list.as_array()
        .expect("a list of templates")
        .iter()
        .filter(|t| t.get("deleted_at").is_none_or(|d| d.is_null()))
        .map(|t| Stored {
            id: t["id"].as_str().unwrap().to_owned(),
            name: t["name"].as_str().unwrap().to_owned(),
            level: t["level"].as_bool().unwrap_or(false),
        })
        .collect()
}

fn enter_structure(view: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<Structure> {
    wait(view, cx, "the book", |ws, _| ws.book.v3().is_some());
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.open_template_structure(window, cx)));
    wait(view, cx, "模板结构", |ws, cx| {
        ws.is_filled(FillPlace::Left)
            && ws.v3_sidebar.as_ref().is_some_and(|sb| {
                sb.read(cx).is_in_structure() && sb.read(cx).template_structure().is_some()
            })
    });
    view.read_with(cx, |ws, cx| {
        ws.v3_sidebar
            .as_ref()
            .unwrap()
            .read(cx)
            .template_structure()
            .unwrap()
    })
}

fn host(
    view: &Entity<Shell>,
    lib: &Workspace,
    id: &str,
    cx: &mut VisualTestContext,
) -> PageViewHost {
    PageViewHost {
        workspace: view.downgrade(),
        library: lib.clone(),
        book_id: id.to_owned(),
        book: view.read_with(cx, |ws, _| ws.book.clone()),
    }
}

fn editor_in_panel(
    structure: &Entity<Structure>,
    cx: &mut VisualTestContext,
) -> Entity<TemplateEditor> {
    structure
        .read_with(cx, |s, _| s.panel())
        .expect("the floating panel")
        .downcast::<TemplateEditor>()
        .expect("the settings-only template editor")
}

fn edit_of(structure: &Entity<Structure>, cx: &mut VisualTestContext) -> serde_json::Value {
    structure.read_with(cx, |s, _| s.state())["edit"].clone()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} drawn"));
    cx.simulate_click(at.center(), Modifiers::default());
    pump(cx);
}

#[gpui::test]
fn a_new_template_is_stored_only_once_the_author_changes_it(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    let structure = enter_structure(&view, cx);
    let before = stored(&lib, &id).len();
    let revision = view.read_with(cx, |ws, _| ws.book.v3().unwrap().revision.clone());

    // In the filled left column: the floating panel, with a new template
    // nobody stored.
    let h = host(&view, &lib, &id, cx);
    cx.update(|window, cx| v3::create_template(h.clone(), window, cx));
    pump(cx);
    assert_eq!(edit_of(&structure, cx), "template:new");
    let editor = editor_in_panel(&structure, cx);
    assert!(!editor.read_with(cx, |e, _| e.touched()));
    assert!(cx.debug_bounds("k5-input-Name").is_some());
    assert_eq!(stored(&lib, &id).len(), before);

    // Closed untouched: nothing behind, the counts stand.
    cx.update(|_, cx| structure.update(cx, |s, cx| s.dismiss_editor(cx)));
    pump(cx);
    assert!(edit_of(&structure, cx).is_null());
    assert_eq!(stored(&lib, &id).len(), before);
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book.v3().unwrap().revision.clone()),
        revision
    );

    // Changed (its level switch) and closed: stored once, as changed.
    cx.update(|window, cx| v3::create_template(h.clone(), window, cx));
    pump(cx);
    let draft_id = editor_in_panel(&structure, cx).read_with(cx, |e, _| e.draft().id.clone());
    click(cx, "k5-toggle-level");
    assert!(editor_in_panel(&structure, cx).read_with(cx, |e, _| e.touched()));
    assert_eq!(
        stored(&lib, &id).len(),
        before,
        "not before the panel closes"
    );
    cx.update(|_, cx| structure.update(cx, |s, cx| s.dismiss_editor(cx)));
    wait(&view, cx, "the new template", |ws, _| {
        ws.book.v3().unwrap().template(&draft_id).is_some()
    });
    let now = stored(&lib, &id);
    assert_eq!(now.len(), before + 1);
    assert!(now.iter().find(|t| t.id == draft_id).unwrap().level);

    // Not filled (the left column's foot): the template is stored at once
    // and K5's full editor opens on it in a new pill; no dialog, no fill.
    cx.update(|window, cx| view.update(cx, |ws, cx| ws.exit_fill(window, cx)));
    pump(cx);
    assert!(!view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)));
    let tabs = view.read_with(cx, |ws, _| ws.nav.tabs().len());
    let h = host(&view, &lib, &id, cx);
    cx.update(|window, cx| v3::create_template(h, window, cx));
    wait(&view, cx, "the new template's pill", |ws, _| {
        ws.nav.tabs().len() == tabs + 1 && matches!(ws.nav.current(), Some(Target::Template(_)))
    });
    let target = view.read_with(cx, |ws, _| ws.nav.current().cloned().unwrap());
    let Target::Template(made) = &target else {
        unreachable!()
    };
    let now = stored(&lib, &id);
    assert_eq!(now.len(), before + 2, "stored as the pill opened");
    assert!(now.iter().any(|t| t.id == made.as_str()));
    assert!(view.read_with(cx, |ws, _| ws.dialog.is_none()), "no dialog");
    assert_eq!(
        view.read_with(cx, |ws, _| ws.filled()),
        None,
        "nothing fills"
    );
    wait(&view, cx, "the full editor", |ws, _| {
        ws.module_page(&target).is_some()
    });
    let page = view.read_with(cx, |ws, _| ws.module_page(&target).cloned().unwrap());
    let full = page
        .downcast::<TemplateEditor>()
        .expect("the pill shows K5's full template editor");
    assert_eq!(
        full.read_with(cx, |e, _| e.draft().id.clone()),
        made.as_str()
    );
    assert!(
        cx.debug_bounds("k5-toggle-level").is_some(),
        "the full editor is drawn on the paper"
    );
}

#[gpui::test]
fn esc_in_the_panel_closes_only_it_and_never_drops_an_edit_silently(cx: &mut TestAppContext) {
    let (_dir, lib, id) = seed();
    let (view, cx) = open(cx, &lib, &id);
    let structure = enter_structure(&view, cx);
    let template = stored(&lib, &id).into_iter().next().expect("a template");
    let revision = view.read_with(cx, |ws, _| ws.book.v3().unwrap().revision.clone());

    // Typed in the name, then Esc: the field shows the stored name again
    // (as the Project Home's name and an entry's title do), the panel
    // closes, the fill stays and nothing is written.
    cx.update(|window, cx| {
        structure.update(cx, |s, cx| s.select_template(&template.id, window, cx))
    });
    pump(cx);
    click(cx, "k5-input-Name");
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("Synthetic typed name");
    pump(cx);
    let editor = editor_in_panel(&structure, cx);
    assert_eq!(
        editor.read_with(cx, |e, _| e.draft().name.clone()),
        "Synthetic typed name"
    );
    cx.simulate_keystrokes("escape");
    pump(cx);
    assert!(edit_of(&structure, cx).is_null(), "the panel closed");
    assert!(
        view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)),
        "the fill stays"
    );
    assert_eq!(
        editor.read_with(cx, |e, _| e.draft().name.clone()),
        template.name
    );
    assert_eq!(
        stored(&lib, &id)
            .iter()
            .find(|t| t.id == template.id)
            .unwrap()
            .name,
        template.name
    );
    assert_eq!(
        view.read_with(cx, |ws, _| ws.book.v3().unwrap().revision.clone()),
        revision
    );

    // A switch flipped, then Esc with no field in hand: the panel closes,
    // the fill stays, and the flip is stored rather than dropped.
    cx.update(|window, cx| {
        structure.update(cx, |s, cx| s.select_template(&template.id, window, cx))
    });
    pump(cx);
    click(cx, "k5-toggle-level");
    cx.simulate_keystrokes("escape");
    pump(cx);
    assert!(edit_of(&structure, cx).is_null(), "the panel closed");
    assert!(
        view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)),
        "the fill stays"
    );
    let tid = template.id.clone();
    wait(&view, cx, "the flip stored", move |ws, _| {
        ws.book
            .v3()
            .unwrap()
            .template(&tid)
            .is_some_and(|t| t.level != template.level)
    });

    // The next Esc leaves the fill.
    cx.simulate_keystrokes("escape");
    pump(cx);
    assert!(!view.read_with(cx, |ws, _| ws.is_filled(FillPlace::Left)));
}
