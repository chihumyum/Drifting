//! Text materials use their real prose document, including in a v3 book.
use dr_editor::ChapterEditor;
use dr_shell::{
    Services, SettingsFile, ShellInfo, Workspace,
    book::Book,
    nav::{Open, Target},
};
use dr_workspace::{Actor, Workspace as Library};
use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn call(lib: &Library, name: &str, input: Value) -> Value {
    lib.call(&Actor::User, name, input).unwrap()["output"].clone()
}
fn fixture() -> (tempfile::TempDir, Library, Vec<String>, Vec<Target>) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        dr_store::Library::open(dir.path(), dr_workspace::library_options("0.2.0-dev")).unwrap();
    let mut books = vec![];
    for seed in [
        dr_testkit::seed::DEFAULT_SEED,
        dr_testkit::seed::DEFAULT_SEED + 1,
    ] {
        let made = dr_testkit::seed::generate_v3(dr_testkit::seed::Preset::Tiny, seed).unwrap();
        books.push(made.books[0].book_id().to_string());
        made.write_to(&store).unwrap();
    }
    store.close().unwrap();
    let lib = Library::open_dir(dir.path(), "0.2.0-dev").unwrap();
    let targets = books
        .iter()
        .map(|book| {
            let b = Book::load(&lib, book).unwrap();
            let id = &b
                .v3()
                .unwrap()
                .materials
                .iter()
                .find(|m| m.kind == "text")
                .unwrap()
                .id;
            Target::Material(id.parse().unwrap())
        })
        .collect();
    (dir, lib, books, targets)
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}
fn wait(cx: &mut VisualTestContext, done: impl Fn(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        cx.run_until_parked();
        draw(cx);
        if done(cx) {
            return;
        }
        assert!(Instant::now() < deadline, "material page did not settle");
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn setup<'a>(
    cx: &'a mut TestAppContext,
    lib: &Library,
    book: &str,
) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
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
        )
    });
    let (view, cx) = cx.add_window_view(Workspace::new);
    wait(cx, |cx| view.read_with(cx, |ws, _| ws.book.v3().is_some()));
    (view, cx)
}
fn open(
    view: &Entity<Workspace>,
    cx: &mut VisualTestContext,
    target: &Target,
) -> Entity<ChapterEditor> {
    view.update(cx, |ws, cx| ws.open(target.clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |ws, _| ws.editor_of(target).is_some())
    });
    let editor = view.read_with(cx, |ws, _| {
        assert!(
            ws.editors[&target.key()].v3.is_none(),
            "a material is not an empty entry composition"
        );
        ws.editor_of(target).unwrap().clone()
    });
    draw(cx);
    cx.update(|window, cx| assert!(editor.read(cx).editor().focus_handle(cx).is_focused(window)));
    editor
}
fn read(lib: &Library, target: &Target) -> Value {
    call(lib, "prose.read", json!({"doc":target.key()}))["paragraphs"].clone()
}
fn prefix(editor: &Entity<ChapterEditor>, cx: &mut VisualTestContext, text: &str) {
    editor.update_in(cx, |e, window, cx| {
        e.editor().update(cx, |p, cx| p.select(0, 0..0, window, cx))
    });
    cx.simulate_input(text);
    cx.run_until_parked();
}

#[gpui::test]
fn material_text_has_an_editor_input_undo_and_a_composer_entry(cx: &mut TestAppContext) {
    let (_dir, lib, books, targets) = fixture();
    let target = &targets[0];
    let before = read(&lib, target);
    let (view, cx) = setup(cx, &lib, &books[0]);
    let editor = open(&view, cx, target);
    editor.read_with(cx, |e, cx| {
        assert_eq!(e.doc_id(), target.key());
        assert_eq!(e.book_id(), books[0]);
        assert_eq!(
            e.editor().read(cx).book().chapters[0]
                .doc
                .line(0)
                .text
                .as_ref(),
            before[0]["text"].as_str().unwrap()
        );
    });
    prefix(&editor, cx, "F6MaterialInput ");
    assert_eq!(
        read(&lib, target)[0]["text"],
        format!("F6MaterialInput {}", before[0]["text"].as_str().unwrap())
    );
    cx.simulate_keystrokes(if cfg!(target_os = "macos") {
        "cmd-z"
    } else {
        "ctrl-z"
    });
    cx.run_until_parked();
    assert_eq!(read(&lib, target), before);
    editor.update_in(cx, |e, window, cx| {
        e.editor().update(cx, |p, cx| p.select(0, 0..2, window, cx))
    });
    cx.simulate_keystrokes(dr_view_review::NEW_COMMENT_KEYS);
    wait(cx, |cx| view.read_with(cx, |ws, _| ws.composer.is_some()));
    // Saving through a v3 composer is a separate G4 interface handoff.
    cx.simulate_keystrokes("escape");
    wait(cx, |cx| view.read_with(cx, |ws, _| ws.composer.is_none()));
    assert_eq!(read(&lib, target), before);
}

#[gpui::test]
fn foreign_material_is_refused_and_switching_books_opens_the_correct_document(
    cx: &mut TestAppContext,
) {
    let (_dir, lib, books, targets) = fixture();
    let before_a = read(&lib, &targets[0]);
    let before_b = read(&lib, &targets[1]);
    let (view, cx) = setup(cx, &lib, &books[0]);
    view.update(cx, |ws, cx| ws.open(targets[1].clone(), Open::KEEP, cx));
    wait(cx, |cx| {
        view.read_with(cx, |ws, _| {
            ws.editors.get(&targets[1].key()).is_some_and(|p| p.failed)
        })
    });
    assert!(view.read_with(cx, |ws, _| ws.editor_of(&targets[1]).is_none()));
    view.update_in(cx, |ws, window, cx| ws.open_book(&books[1], window, cx));
    wait(cx, |cx| {
        view.read_with(cx, |ws, _| ws.book_id == books[1] && ws.book.v3().is_some())
    });
    let editor = open(&view, cx, &targets[1]);
    prefix(&editor, cx, "F6OtherMaterial ");
    assert_eq!(
        read(&lib, &targets[1])[0]["text"],
        format!("F6OtherMaterial {}", before_b[0]["text"].as_str().unwrap())
    );
    assert_eq!(read(&lib, &targets[0]), before_a);
}

// A registered module gives the shell its wrapper's focus; its real text
// field is a descendant, just like G1's asynchronous body renderer.
struct BodyFocus {
    focus: gpui::FocusHandle,
    field: Entity<dr_ui::input::TextField>,
}
impl gpui::Render for BodyFocus {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{InteractiveElement as _, ParentElement as _, Styled as _};
        gpui::div()
            .id("body-focus-probe")
            .track_focus(&self.focus)
            .size_full()
            .child(self.field.clone())
    }
}

#[gpui::test]
fn navigation_from_a_modules_child_editor_hands_focus_to_material_prose(cx: &mut TestAppContext) {
    let (_dir, lib, books, targets) = fixture();
    let mounted = std::rc::Rc::new(std::cell::RefCell::new(None));
    let made = mounted.clone();
    cx.update(|cx| {
        dr_shell::v3::add_module_view(cx, "prose", move |_, window, cx| {
            let body = cx.new(|cx: &mut gpui::Context<BodyFocus>| {
                let focus = cx.focus_handle();
                let field =
                    cx.new(|cx| dr_ui::input::TextField::new("body-focus-field", window, cx));
                *made.borrow_mut() = Some(field.clone());
                BodyFocus { focus, field }
            });
            dr_shell::v3::Rendered::new(body.clone()).focus(body.read(cx).focus.clone())
        })
    });
    let (view, cx) = setup(cx, &lib, &books[0]);
    let entry = view.read_with(cx, |ws, _| {
        let entry = ws
            .book
            .v3()
            .unwrap()
            .entries
            .iter()
            .find(|e| e.template.as_deref() == Some("tpl-chapter"))
            .unwrap();
        Target::from_key(&format!("entry:{}/mod-prose", entry.id)).unwrap()
    });
    view.update(cx, |ws, cx| ws.open(entry.clone(), Open::KEEP, cx));
    wait(cx, |_| mounted.borrow().is_some());
    let field = mounted.borrow().as_ref().unwrap().clone();
    cx.update(|window, cx| field.focus_handle(cx).focus(window, cx));
    draw(cx);
    let focus = view
        .read_with(cx, |ws, cx| {
            ws.editors
                .get(&entry.key())
                .and_then(|p| p.v3.as_ref())
                .map(|p| p.read(cx).preferred_focus())
        })
        .unwrap();
    cx.update(|window, cx| {
        assert!(
            focus.contains_focused(window, cx) && !focus.is_focused(window),
            "the module's child owns the keyboard before navigating"
        )
    });
    let editor = open(&view, cx, &targets[0]);
    let before = read(&lib, &targets[0]);
    prefix(&editor, cx, "F6FocusedMaterial ");
    assert_eq!(
        read(&lib, &targets[0])[0]["text"],
        format!("F6FocusedMaterial {}", before[0]["text"].as_str().unwrap())
    );
}
