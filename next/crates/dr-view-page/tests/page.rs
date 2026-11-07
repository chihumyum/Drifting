//! The chapter page's head and end on GPUI's test platform, around a real
//! editor on a real workspace: the title hands the caret to the text and is
//! stored when left, Esc and an empty title put the stored one back, the
//! synopsis is stored when left, ⁂ finishes the chapter and makes the next,
//! whose title then takes the caret, selected; an idea's page stores its
//! title and synopsis the same way.

use std::time::{Duration, Instant};

use dr_editor::{ChapterEditor, EditorSettings, SessionSource};
use dr_shell::pages::{PageEditorRef, PageHost};
use dr_shell::{Services, SettingsFile, ShellInfo};
use dr_store::Library;
use dr_ui::Appearance;
use dr_view_page::{Chrome, EndAction, page_views};
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{
    Entity, EntityInputHandler as _, Focusable as _, TestAppContext, VisualTestContext, WeakEntity,
    px, size,
};
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
    let book = out(&ws, "book.create", json!({"name": "页面"}))["id"]
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

fn chapters(e: &Env) -> Vec<Value> {
    out(&e.ws, "chapter.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .clone()
}

fn titles(e: &Env) -> Vec<String> {
    chapters(e)
        .iter()
        .map(|c| c["title"].as_str().unwrap().to_owned())
        .collect()
}

fn info() -> ShellInfo {
    ShellInfo {
        app_name: "Drifting Next",
        bundle_id: "cc.drifting.next.dev",
        version: "0.2.0-dev",
        url_scheme: "drifting-next-dev",
        forced_appearance: Some(Appearance::Light),
    }
}

/// The shell's globals (strings, settings, keys), then `doc` in an editor
/// with the page's chrome on it, drawn once.
fn open(cx: &mut TestAppContext, e: &Env, doc: &str) -> (Entity<ChapterEditor>, VisualTestContext) {
    cx.executor().allow_parking();
    cx.update(|cx| {
        if cx.try_global::<dr_shell::strings::Strings>().is_none() {
            let mut file = SettingsFile::in_memory();
            file.set(
                dr_shell::settings::registry::UI_LOCALE,
                "zh-CN".into(),
                None,
            )
            .ok();
            dr_shell::init(info(), Services::default(), file, cx);
        }
    });
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    let source = SessionSource::open(&ws, &doc).unwrap();
    let window = cx.add_window(|window, cx| {
        let mut editor = ChapterEditor::with_session(
            ws.clone(),
            &book,
            &doc,
            source,
            EditorSettings::default(),
            window,
            cx,
        );
        let host = PageHost {
            workspace: WeakEntity::new_invalid(),
            library: ws,
            book,
            editor: PageEditorRef::Doc(cx.entity().downgrade()),
        };
        editor.set_chrome(Some(std::rc::Rc::new(Chrome::new(host))), cx);
        editor
    });
    let view = window.root(cx).unwrap();
    let mut vcx = VisualTestContext::from_window(window.into(), cx);
    // GPUI reports focus changes (and so blurs) only in an active window.
    vcx.update(|window, _| window.activate_window());
    vcx.simulate_resize(size(px(900.), px(900.)));
    draw(&mut vcx);
    (view, vcx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

/// Until `done` holds: the workspace writes on its own threads.
fn wait_for(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        draw(cx);
        if done(cx) || Instant::now() > deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn type_into(field: &Entity<dr_ui::input::TextArea>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    draw(cx);
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.select_all_text(cx);
            f.replace_text_in_range(None, text, window, cx);
        });
    });
    draw(cx);
}

#[gpui::test]
fn the_title_hands_the_caret_to_the_text_and_is_stored_when_left(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜", "他把吸铁石拍在桌上。");
    let (view, mut cx) = open(cx, &e, &doc);
    let (head, _) = cx
        .update(|_, cx| page_views(&doc, cx))
        .expect("the page was drawn");
    let title = head.read_with(&cx, |h, _| h.title().clone());
    assert_eq!(title.read_with(&cx, |f, _| f.text()), "雨夜");
    type_into(&title, "夜雨", &mut cx);
    cx.simulate_keystrokes("enter");
    draw(&mut cx);
    // The text has the keyboard now; leaving the field stored the title.
    let editor = view.read_with(&cx, |v, _| v.editor().clone());
    assert!(cx.update(|window, cx| editor.focus_handle(cx).is_focused(window)));
    wait_for(&mut cx, |_| titles(&e) == ["夜雨"]);
    assert_eq!(titles(&e), ["夜雨"]);
}

#[gpui::test]
fn esc_and_an_empty_title_put_the_stored_one_back(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜", "他把吸铁石拍在桌上。");
    let (_, mut cx) = open(cx, &e, &doc);
    let (head, _) = cx.update(|_, cx| page_views(&doc, cx)).unwrap();
    let title = head.read_with(&cx, |h, _| h.title().clone());
    type_into(&title, "别的名字", &mut cx);
    cx.simulate_keystrokes("escape");
    draw(&mut cx);
    assert_eq!(title.read_with(&cx, |f, _| f.text()), "雨夜");
    // Cleared and left: nothing is stored, the field shows the title again.
    type_into(&title, "", &mut cx);
    cx.update(|window, cx| window.blur(cx));
    wait_for(&mut cx, |cx| title.read_with(cx, |f, _| f.text()) == "雨夜");
    assert_eq!(title.read_with(&cx, |f, _| f.text()), "雨夜");
    assert_eq!(titles(&e), ["雨夜"]);
}

#[gpui::test]
fn the_synopsis_is_stored_when_left(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜", "他把吸铁石拍在桌上。");
    let (_, mut cx) = open(cx, &e, &doc);
    let (head, _) = cx.update(|_, cx| page_views(&doc, cx)).unwrap();
    let synopsis = head.read_with(&cx, |h, _| h.synopsis().clone());
    type_into(&synopsis, "码头上的第一夜。", &mut cx);
    cx.update(|window, cx| window.blur(cx));
    let summary = |e: &Env| {
        chapters(e)[0]["summary"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };
    wait_for(&mut cx, |_| summary(&e) == "码头上的第一夜。");
    assert_eq!(summary(&e), "码头上的第一夜。");
}

#[gpui::test]
fn the_end_finishes_the_chapter_and_makes_the_next(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "雨夜", "他把吸铁石拍在桌上。");
    chapter(&e, "天明", "");
    let (_, mut cx) = open(cx, &e, &doc);
    let (_, end) = cx.update(|_, cx| page_views(&doc, cx)).unwrap();
    let status = |e: &Env| chapters(e)[0]["status"].as_str().unwrap().to_owned();
    cx.update(|window, cx| end.update(cx, |end, cx| end.choose(EndAction::Finish, window, cx)));
    wait_for(&mut cx, |_| status(&e) == "finished");
    assert_eq!(status(&e), "finished");
    // The page heard of it: the same action now puts it back to draft.
    wait_for(&mut cx, |cx| {
        end.read_with(cx, |end, _| end.page().finished())
    });
    cx.update(|window, cx| end.update(cx, |end, cx| end.choose(EndAction::Finish, window, cx)));
    wait_for(&mut cx, |_| status(&e) == "draft");
    assert_eq!(status(&e), "draft");
    // The next chapter goes right after this one, before 「天明」.
    cx.update(|window, cx| end.update(cx, |end, cx| end.choose(EndAction::Next, window, cx)));
    wait_for(&mut cx, |_| titles(&e).len() == 3);
    assert_eq!(titles(&e), ["雨夜", "新章节", "天明"]);
    // Opened (the shell opens it in a tab), its title has the caret,
    // all of it selected.
    let new_doc = format!("node:{}", chapters(&e)[1]["id"].as_str().unwrap());
    let mut app = cx.cx.clone();
    let (_, mut cx2) = open(&mut app, &e, &new_doc);
    let (head, _) = cx2.update(|_, cx| page_views(&new_doc, cx)).unwrap();
    let title = head.read_with(&cx2, |h, _| h.title().clone());
    draw(&mut cx2);
    assert!(cx2.update(|window, cx| title.focus_handle(cx).is_focused(window)));
    let (selection, len) = title.read_with(&cx2, |f, _| (f.composer().selection(), f.text().len()));
    assert_eq!(selection, 0..len);
}

#[gpui::test]
fn an_idea_page_stores_its_title_and_synopsis(cx: &mut TestAppContext) {
    let e = env();
    let id = out(
        &e.ws,
        "idea.create",
        json!({"book": e.book, "title": "灯塔", "text": "雾里有人敲钟。"}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = format!("node:{id}");
    let (_, mut cx) = open(cx, &e, &doc);
    let (head, end) = cx
        .update(|_, cx| page_views(&doc, cx))
        .expect("an idea has a head");
    let (title, synopsis) = head.read_with(&cx, |h, _| (h.title().clone(), h.synopsis().clone()));
    assert_eq!(title.read_with(&cx, |f, _| f.text()), "灯塔");
    type_into(&title, "雾中灯塔", &mut cx);
    type_into(&synopsis, "守灯人的最后一夜。", &mut cx);
    cx.update(|window, cx| window.blur(cx));
    let idea = |e: &Env| {
        out(&e.ws, "idea.list", json!({"book": e.book}))
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"].as_str() == Some(id.as_str()))
            .cloned()
            .unwrap()
    };
    wait_for(&mut cx, |_| {
        let i = idea(&e);
        i["title"] == "雾中灯塔" && i["summary"] == "守灯人的最后一夜。"
    });
    let i = idea(&e);
    assert_eq!(i["title"], "雾中灯塔");
    assert_eq!(i["summary"], "守灯人的最后一夜。");
    // ⁂ on an idea has no actions.
    cx.update(|window, cx| end.update(cx, |end, cx| end.open_actions(window, cx)));
    assert!(!end.read_with(&cx, |end, _| end.is_open()));
}
