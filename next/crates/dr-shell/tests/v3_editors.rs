//! Renderer-owned editors are adopted per mounted page, not per document.
use dr_editor::ChapterEditor;
use dr_shell::{
    Services, Settings, SettingsFile, ShellInfo, Workspace,
    nav::{Open, Target},
    settings::registry,
    workspace::editors::PageView,
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{
    App, Context, Entity, Focusable as _, TestAppContext, VisualTestContext, WeakEntity, Window,
    div, prelude::*,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn fixture() -> (tempfile::TempDir, Library, String, String) {
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
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let entries = call(&lib, "entry.list", json!({"book":book,"all":true}));
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["template"] == "tpl-chapter")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let body = call(
        &lib,
        "module.read_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose"}),
    );
    // Reuse the seed's prose for a document with a nonzero reading position.
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"mod-prose","paragraphs":(0..48).map(|_| json!({"text":body["paragraphs"][0]["text"]})).collect::<Vec<_>>()}),
    );
    call(
        &lib,
        "entry_template.put_module",
        json!({"book":book,"template":"tpl-chapter","module":{"id":"second","name":"Second","kind":"prose"}}),
    );
    call(
        &lib,
        "module.set_prose",
        json!({"book":book,"owner":entry,"module":"second","paragraphs":[{"text":body["paragraphs"][0]["text"]}]}),
    );
    (dir, lib, book, entry)
}

struct Body {
    module: String,
    editor: Option<Entity<ChapterEditor>>,
}
impl Render for Body {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().children(self.editor.clone())
    }
}
type Bodies = Rc<RefCell<Vec<WeakEntity<Body>>>>;

struct Whole {
    editor: Entity<dr_editor::BookEditor>,
    focus: gpui::FocusHandle,
}
impl Render for Whole {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("mounted-whole")
            .track_focus(&self.focus)
            .size_full()
            .min_h_0()
            .child(self.editor.clone())
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
    wrong_library: Option<Library>,
) -> (Entity<Workspace>, Bodies, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    let bodies = Bodies::default();
    cx.update(|cx| {
        dr_shell::pages::add_page_view(cx, |target, host, window, cx| {
            let Target::Book(from) = target else {
                return None;
            };
            let prepared =
                dr_editor::BookEditor::prepare(&host.library, &host.book_id, from.as_str())
                    .unwrap();
            let editor = cx.new(|cx| {
                dr_editor::BookEditor::with_prepared(
                    host.library.clone(),
                    prepared,
                    Default::default(),
                    window,
                    cx,
                )
            });
            let view = cx.new(|cx| {
                let focus = cx.focus_handle();
                cx.on_focus(&focus, window, |v: &mut Whole, window, cx| {
                    let prose = v.editor.read(cx).editor().clone();
                    window.defer(cx, move |window, cx| {
                        prose.focus_handle(cx).focus(window, cx);
                    });
                })
                .detach();
                Whole { editor, focus }
            });
            let focus = view.read(cx).focus.clone();
            dr_shell::v3::register_editor(
                &host,
                &view,
                |v, _| Some(PageView::Book(v.editor.clone())),
                cx,
            );
            Some(dr_shell::pages::ModulePage {
                view: view.into(),
                focus,
            })
        });
        let seen = bodies.clone();
        dr_shell::v3::add_module_view(cx, "prose", move |host, window, cx| {
            let source = dr_editor::v3::prepare_body(
                &host.page.library,
                &host.page.book_id,
                &host.entry,
                &host.module.id,
            )
            .unwrap();
            let doc = format!("body:{}/{}", host.entry, host.module.id);
            let editor = cx.new(|cx| {
                ChapterEditor::with_session(
                    host.page.library.clone(),
                    &host.page.book_id,
                    &doc,
                    source,
                    Default::default(),
                    window,
                    cx,
                )
            });
            let focus = editor.read(cx).editor().focus_handle(cx);
            let view = cx.new(|_| Body {
                module: host.module.id.clone(),
                editor: Some(editor),
            });
            let mut scope = host.page.clone();
            if let Some(wrong) = &wrong_library {
                scope.library = wrong.clone();
            }
            dr_shell::v3::register_editor(
                &scope,
                &view,
                |v, _| v.editor.clone().map(PageView::Doc),
                cx,
            );
            seen.borrow_mut().push(view.downgrade());
            dr_shell::v3::Rendered::new(view).focus(focus)
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
                book: Some(book.into()),
                ..Default::default()
            },
            SettingsFile::in_memory(),
            cx,
        );
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    cx.update(|window, _| window.activate_window());
    wait(&view, cx, |w, _| w.book.v3().is_some());
    (view, bodies, cx)
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}
fn wait(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    done: impl Fn(&Workspace, &App) -> bool,
) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        draw(cx);
        if view.read_with(cx, |w, cx| done(w, cx)) {
            return;
        }
        assert!(Instant::now() < until, "mounted editors did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn target(entry: &str, module: Option<&str>) -> Target {
    Target::Entry {
        id: entry.parse().unwrap(),
        module: module.map(|m| m.parse().unwrap()),
    }
}
fn open(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    target: &Target,
) -> Entity<ChapterEditor> {
    view.update(cx, |w, cx| w.open(target.clone(), Open::KEEP, cx));
    wait(view, cx, |w, _| w.editor_of(target).is_some());
    view.read_with(cx, |w, _| w.editor_of(target).unwrap().clone())
}

#[gpui::test]
fn two_pages_of_one_body_keep_their_own_mounted_editor_and_release(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (view, bodies, cx) = setup(cx, &lib, &book, None);
    let whole = target(&entry, None);
    let exact = target(&entry, Some("mod-prose"));
    let first = open(&view, cx, &whole);
    let first_roots: Vec<_> = bodies.borrow().clone();
    let second = open(&view, cx, &exact);
    assert_ne!(first.entity_id(), second.entity_id());
    assert_eq!(
        first.read_with(cx, |e, _| e.doc_id().to_owned()),
        second.read_with(cx, |e, _| e.doc_id().to_owned())
    );
    second.update_in(cx, |e, window, cx| {
        e.editor().update(cx, |p, cx| p.select(0, 0..2, window, cx))
    });
    assert_eq!(
        first.read_with(cx, |e, cx| e.editor().read(cx).selection().head),
        0
    );
    view.update(cx, |w, cx| {
        w.nav.close_active();
        cx.notify();
    });
    wait(&view, cx, |w, _| !w.editors.contains_key(&exact.key()));
    cx.run_until_parked();
    assert!(
        bodies
            .borrow()
            .iter()
            .skip(first_roots.len())
            .all(|v| v.upgrade().is_none())
    );
    assert!(first_roots.iter().all(|v| v.upgrade().is_some()));
    assert_eq!(
        view.read_with(cx, |w, _| w.editor_of(&whole).unwrap().entity_id()),
        first.entity_id()
    );
    // Getter returning None releases the shell's old editor as well.
    let root = first_roots
        .iter()
        .filter_map(WeakEntity::upgrade)
        .find(|v| v.read_with(cx, |v, _| v.module == "mod-prose"))
        .unwrap();
    root.update(cx, |v, cx| {
        v.editor = None;
        cx.notify();
    });
    wait(&view, cx, |w, _| {
        w.editor_of(&whole)
            .is_some_and(|e| e.entity_id() != first.entity_id())
    });
}

#[gpui::test]
fn focused_module_drives_find_composer_preferences_and_immersive(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (view, bodies, cx) = setup(cx, &lib, &book, None);
    let whole = target(&entry, None);
    open(&view, cx, &whole);
    let editors: Vec<_> = bodies
        .borrow()
        .iter()
        .filter_map(WeakEntity::upgrade)
        .map(|v| v.read_with(cx, |v, _| v.editor.clone().unwrap()))
        .collect();
    let second = editors
        .iter()
        .find(|e| e.read_with(cx, |e, _| e.doc_id().ends_with("/second")))
        .unwrap()
        .clone();
    cx.update(|window, cx| second.read(cx).editor().focus_handle(cx).focus(window, cx));
    wait(&view, cx, |w, _| {
        w.editor_of(&whole)
            .is_some_and(|e| e.entity_id() == second.entity_id())
    });
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    assert!(view.read_with(cx, |w, _| w.find.is_some()));
    let find = view.read_with(cx, |w, _| w.find.clone().unwrap());
    assert_eq!(
        find.read_with(cx, |f, _| f.prose.entity_id()),
        second.read_with(cx, |e, _| e.editor().entity_id())
    );
    let query = second.read_with(cx, |e, cx| {
        e.plain_text(cx).chars().take(1).collect::<String>()
    });
    find.update_in(cx, |f, window, cx| f.set_query(&query, window, cx));
    assert!(find.read_with(cx, |f, _| f.status().total > 0));
    draw(cx);
    assert!(
        view.read_with(cx, |w, _| w.find.is_some()),
        "the selected module remains selected while the find field owns focus"
    );
    view.update_in(cx, |w, window, cx| w.close_find(window, cx));
    second.update_in(cx, |e, window, cx| {
        e.editor().update(cx, |p, cx| p.select(0, 0..2, window, cx))
    });
    cx.simulate_keystrokes("secondary-alt-m");
    assert!(view.read_with(cx, |w, _| w.composer.is_some()));
    cx.simulate_keystrokes("escape");
    cx.update(|_, cx| {
        Settings::update(cx, |f| f.set(registry::FONT_SIZE, json!(23), None)).unwrap();
        Settings::update(cx, |f| f.set(registry::THEME, json!("dark"), None)).unwrap();
    });
    draw(cx);
    for editor in &editors {
        editor.read_with(cx, |e, cx| {
            assert_eq!(
                e.settings(),
                &dr_shell::workspace::editors::editor_settings(cx)
            )
        });
        cx.update(|window, cx| {
            assert_eq!(
                editor.read(cx).editor().read(cx).style().text,
                dr_shell::workspace::editors::base_style(&dr_ui::Theme::of(window, cx)).text
            );
        });
    }
    view.update(cx, |w, cx| w.set_immersive(true, cx));
    draw(cx);
    for editor in &editors {
        assert!(editor.read_with(cx, |e, _| e.immersive()));
    }
    assert!(second.read_with(cx, |e, cx| e.editor().read(cx).paragraph_focus()));
}

#[gpui::test]
fn identical_book_ids_in_another_library_cannot_register_into_this_page(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (_other_dir, other, other_book, _) = fixture();
    assert_eq!(book, other_book);
    let (view, _, cx) = setup(cx, &lib, &book, Some(other));
    let wanted = target(&entry, Some("mod-prose"));
    view.update(cx, |w, cx| w.open(wanted.clone(), Open::KEEP, cx));
    wait(&view, cx, |w, cx| {
        w.editors
            .get(&wanted.key())
            .and_then(|p| p.v3.as_ref())
            .is_some_and(|v| !v.read(cx).sections.is_empty())
    });
    for _ in 0..3 {
        draw(cx);
        cx.run_until_parked();
    }
    assert!(view.read_with(cx, |w, _| w.editor_of(&wanted).is_none()));
}

#[gpui::test]
fn the_registered_manuscript_uses_the_shared_find_and_reading_position(cx: &mut TestAppContext) {
    let (_dir, lib, book, entry) = fixture();
    let (view, _, cx) = setup(cx, &lib, &book, None);
    let manuscript_id = view.read_with(cx, |w, _| w.book.v3().unwrap().roots[0].clone());
    let book_target = Target::Book(manuscript_id.parse().unwrap());
    view.update(cx, |w, cx| w.open(book_target.clone(), Open::KEEP, cx));
    wait(&view, cx, |w, _| w.book_editor().is_some());
    let editor = view.read_with(cx, |w, _| w.book_editor().unwrap().clone());
    let doc = format!("body:{entry}/mod-prose");
    editor.update_in(cx, |e, window, cx| {
        assert!(e.reveal_line(&doc, 3, window, cx))
    });
    draw(cx);
    let expected = editor.read_with(cx, |e, cx| e.reading_position(cx).unwrap());
    assert!(expected.paragraph > 0 || expected.offset > 0.0);
    view.update(cx, |w, cx| w.store_layout(cx));
    let position = cx.update(|_, cx| {
        Settings::read(cx).layout(&book).unwrap()["book_positions"][manuscript_id.as_str()].clone()
    });
    assert_eq!(position["doc"], doc);
    assert_eq!(position["paragraph"], expected.paragraph);
    assert_eq!(position["offset"], json!(expected.offset));
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    assert_eq!(
        view.read_with(cx, |w, cx| w
            .find
            .as_ref()
            .unwrap()
            .read(cx)
            .prose
            .entity_id()),
        editor.read_with(cx, |e, _| e.editor().entity_id())
    );
    view.update_in(cx, |w, window, cx| w.close_find(window, cx));
    view.update(cx, |w, cx| {
        w.nav.close_active();
        cx.notify();
    });
    wait(&view, cx, |w, _| w.book_editor().is_none());
    view.update(cx, |w, cx| w.open(book_target.clone(), Open::KEEP, cx));
    wait(&view, cx, |w, _| w.book_editor().is_some());
    let restored = view.read_with(cx, |w, cx| {
        w.book_editor()
            .unwrap()
            .read(cx)
            .reading_position(cx)
            .unwrap()
    });
    assert_eq!(restored.doc, doc);
    assert_eq!(restored.paragraph, expected.paragraph);
    assert!((restored.offset - expected.offset).abs() < 0.1);
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    let editor = view.read_with(cx, |w, _| w.book_editor().unwrap().clone());
    let before = editor.read_with(cx, |e, _| e.editor().entity_id());
    editor.update_in(cx, |e, window, cx| e.reload(window, cx).unwrap());
    wait(&view, cx, |w, cx| {
        w.find.is_none() && w.book_editor().unwrap().read(cx).editor().entity_id() != before
    });
    for _ in 0..3 {
        draw(cx);
        cx.run_until_parked();
    }
    cx.update(|window, cx| {
        assert!(
            editor.read(cx).editor().focus_handle(cx).is_focused(window),
            "reloading while find owns the keyboard returns focus to the mounted editor"
        );
    });
    view.update_in(cx, |w, window, cx| w.open_find(window, cx));
    assert_eq!(
        view.read_with(cx, |w, cx| w
            .find
            .as_ref()
            .unwrap()
            .read(cx)
            .prose
            .entity_id()),
        editor.read_with(cx, |e, _| e.editor().entity_id())
    );
}
