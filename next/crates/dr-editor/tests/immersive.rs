//! Immersive writing's editor part (M26): typewriter scrolling forced on
//! while immersed, and the author's writing told from other writes (the
//! shell's 「打字时自动沉浸」).

use std::cell::RefCell;
use std::rc::Rc;

use dr_editor::{BookEditor, ChapterEditor, EditorSettings, WritingTyped};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, EntityInputHandler, Focusable, TestAppContext, VisualTestContext, px, size};
use gpui_prose::ProseEditor;
use serde_json::{Value, json};

struct Env {
    _dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(&Actor::User, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "book.create", json!({"name": "沉浸"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn chapter(e: &Env, title: &str, text: &str) -> String {
    let id = out(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    format!("node:{id}")
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn typewriter(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Option<f32> {
    editor.read_with(cx, |e, _| e.style().typewriter)
}

/// Every `WritingTyped` a view emits, by document.
fn record<V: gpui::EventEmitter<WritingTyped>>(
    view: &Entity<V>,
    cx: &mut VisualTestContext,
) -> Rc<RefCell<Vec<String>>> {
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = seen.clone();
    cx.update(|_, cx| {
        cx.subscribe(view, move |_, e: &WritingTyped, _| {
            sink.borrow_mut().push(e.doc.clone())
        })
        .detach()
    });
    seen
}

fn settings(typewriter: bool, position: f32) -> EditorSettings {
    EditorSettings {
        typewriter,
        typewriter_position: position,
        ..EditorSettings::default()
    }
}

#[gpui::test]
fn immersion_turns_the_typewriter_on_and_leaving_gives_the_setting_back(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "一", "开头。\n");
    let (ws, book, d) = (e.ws.clone(), e.book.clone(), doc.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &d, settings(false, 0.3), window, cx).unwrap()
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    assert_eq!(typewriter(&editor, cx), None, "the setting is off");
    view.update(cx, |v, cx| v.set_immersive(true, cx));
    assert!(view.read_with(cx, |v, _| v.immersive()));
    assert_eq!(
        typewriter(&editor, cx),
        Some(0.3),
        "on, on the setting's line"
    );
    // The line moves while immersed: the typewriter follows it.
    view.update(cx, |v, cx| v.set_settings(settings(false, 0.6), cx));
    assert_eq!(typewriter(&editor, cx), Some(0.6));
    // The theme changes while immersed: still on.
    let base = editor.read_with(cx, |e, _| e.style().clone());
    view.update(cx, |v, cx| v.set_base_style(base, cx));
    assert_eq!(typewriter(&editor, cx), Some(0.6));
    view.update(cx, |v, cx| v.set_immersive(false, cx));
    assert_eq!(typewriter(&editor, cx), None, "back to the setting");
    // With the setting on, leaving keeps it on.
    view.update(cx, |v, cx| v.set_settings(settings(true, 0.5), cx));
    view.update(cx, |v, cx| v.set_immersive(true, cx));
    view.update(cx, |v, cx| v.set_immersive(false, cx));
    assert_eq!(typewriter(&editor, cx), Some(0.5));
}

#[gpui::test]
fn the_authors_writing_is_told_from_other_writes(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "一", "开头。\n");
    let (ws, book, d) = (e.ws.clone(), e.book.clone(), doc.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &d, EditorSettings::default(), window, cx).unwrap()
    });
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let focus = editor.read_with(cx, |e, cx| e.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    let seen = record(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 3..3, window, cx);
        e.paste_text("贴来的", window, cx);
        e.press_backspace(window, cx);
    });
    draw(cx);
    assert!(
        seen.borrow().is_empty(),
        "a paste and a deletion are not writing"
    );
    editor.update_in(cx, |e, window, cx| {
        e.replace_and_mark_text_in_range(None, "xie", Some(3..3), window, cx)
    });
    draw(cx);
    assert!(seen.borrow().is_empty(), "nor the input method composing");
    editor.update_in(cx, |e, window, cx| {
        e.replace_text_in_range(None, "写", window, cx)
    });
    draw(cx);
    assert_eq!(*seen.borrow(), [doc.as_str()]);
    editor.update_in(cx, |e, window, cx| e.press_enter(window, cx));
    draw(cx);
    assert_eq!(seen.borrow().len(), 2, "Enter");
}

#[gpui::test]
fn the_book_view_says_which_chapter_was_written_in(cx: &mut TestAppContext) {
    let e = env();
    chapter(&e, "一", "第一章。\n");
    let second = chapter(&e, "二", "第二章。\n");
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        BookEditor::open(ws, &book, settings(false, 0.4), window, cx).unwrap()
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let seen = record(&view, cx);
    editor.update_in(cx, |e, window, cx| {
        e.select(1, 0..0, window, cx);
        e.replace_text_in_range(None, "又", window, cx);
    });
    draw(cx);
    assert_eq!(*seen.borrow(), [second]);
    view.update(cx, |v, cx| v.set_immersive(true, cx));
    assert_eq!(typewriter(&editor, cx), Some(0.4));
    view.update(cx, |v, cx| v.set_immersive(false, cx));
    assert_eq!(typewriter(&editor, cx), None);
}
