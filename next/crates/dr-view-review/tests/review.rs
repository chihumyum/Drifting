//! The Review tab and the composer on a real workspace (GPUI's test
//! platform): filters, scope and groups; completing a TODO; editing in
//! place; jumping to the text; a comment written from the selection.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use dr_editor::decor::ReviewFocus;
use dr_editor::{ChapterEditor, EditorSettings};
use dr_i18n::{Locale, Platform};
use dr_model::id::NodeId;
use dr_store::Library;
use dr_view_review::{CommentComposer, Filter, ReviewView};
use dr_workspace::{Actor, NavTarget, Workspace, WorkspaceOptions, library_options};
use gpui::{
    Context, Entity, IntoElement, ParentElement, Render, Styled, TestAppContext, VisualTestContext,
    Window, div,
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
    let book = out(&ws, "book.create", json!({"name": "审阅"}))["id"]
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
    out(
        &e.ws,
        "chapter.create",
        json!({"book": e.book, "title": title, "text": text}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn comment(e: &Env, on: Option<&str>, kind: &str, body: &str) -> String {
    let mut input = json!({"book": e.book, "kind": kind, "body": body});
    if let Some(id) = on {
        input["target"] = json!({"kind": "node", "id": id});
        input["range"] = json!([0, 2]);
    }
    out(&e.ws, "comment.create", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn listed(e: &Env) -> Vec<Value> {
    out(&e.ws, "comment.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .clone()
}

struct Root {
    book: String,
    target: Option<NavTarget>,
    opened: Rc<RefCell<Vec<String>>>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let opened = self.opened.clone();
        let open: dr_view_review::Opener =
            Rc::new(move |key, _, _| opened.borrow_mut().push(key.to_owned()));
        div().size_full().child(dr_view_review::panel(
            "review-test",
            &self.book,
            self.target.clone(),
            Locale::ZhCn,
            Platform::Mac,
            open,
            cx,
        ))
    }
}

fn wait_for(
    cx: &mut VisualTestContext,
    mut done: impl FnMut(&mut VisualTestContext) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        if done(cx) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn redraw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
}

fn open_tab<'a>(
    cx: &'a mut TestAppContext,
    e: &Env,
    target: Option<NavTarget>,
) -> (
    Entity<ReviewView>,
    Rc<RefCell<Vec<String>>>,
    &'a mut VisualTestContext,
) {
    cx.executor().allow_parking();
    let ws = e.ws.clone();
    cx.update(|cx| dr_view_review::init(Some(ws), cx));
    let opened: Rc<RefCell<Vec<String>>> = Rc::default();
    let (book, o) = (e.book.clone(), opened.clone());
    let (_root, cx) = cx.add_window_view(move |_, _| Root {
        book,
        target,
        opened: o,
    });
    redraw(cx);
    let view = cx
        .update(|_, cx| dr_view_review::view("review-test", cx))
        .unwrap();
    (view, opened, cx)
}

fn ids(view: &Entity<ReviewView>, cx: &mut VisualTestContext) -> Vec<Vec<String>> {
    view.read_with(cx, |v, _| {
        v.listing()
            .open
            .iter()
            .map(|g| g.items.iter().map(|i| i.body.clone()).collect())
            .collect()
    })
}

#[gpui::test]
fn the_tab_filters_scopes_and_groups_by_place(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let two = chapter(&e, "二", "他在楼下等。");
    comment(&e, Some(&one), "note", "一的批注");
    comment(&e, Some(&two), "todo", "二的待办");
    comment(&e, None, "todo", "浮动待办");
    let target = NavTarget::Chapter(NodeId::parse(&one).unwrap());
    let (view, _, cx) = open_tab(cx, &e, Some(target));
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 3));
    // Grouped by place, the floating one last.
    let groups = ids(&view, cx);
    assert_eq!(groups.last().unwrap(), &vec!["浮动待办".to_owned()]);
    view.update(cx, |v, cx| v.set_filter(Filter::Todos, cx));
    let todos = ids(&view, cx).concat();
    assert_eq!(todos.len(), 2);
    assert!(!todos.contains(&"一的批注".to_owned()));
    // 当前: only the open tab's chapter.
    view.update(cx, |v, cx| {
        v.set_filter(Filter::All, cx);
        v.set_current_only(true, cx);
    });
    assert_eq!(ids(&view, cx), vec![vec!["一的批注".to_owned()]]);
    redraw(cx);
    // A comment written elsewhere shows up.
    view.update(cx, |v, cx| v.set_current_only(false, cx));
    comment(&e, Some(&one), "note", "后来的");
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 4));
}

#[gpui::test]
fn a_todo_is_completed_and_a_body_edited_in_place(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let todo = comment(&e, Some(&one), "todo", "查钟楼的年代");
    let note = comment(&e, Some(&one), "note", "这里太快");
    let (view, _, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 2));
    view.update(cx, |v, cx| v.set_done(&todo, true, cx));
    assert!(wait_for(cx, |_| listed(&e)
        .iter()
        .any(|c| c["id"] == todo.as_str() && c["status"] == "resolved")));
    // The resolved TODO moves to the folded section.
    assert!(wait_for(cx, |cx| view
        .read_with(cx, |v, _| v.listing().resolved_count)
        == 1));
    redraw(cx);
    // Double-click to edit; Enter saves.
    cx.update(|window, cx| view.update(cx, |v, cx| v.edit(&note, window, cx)));
    view.update(cx, |v, cx| {
        v.finish_edit(&note, Some("这里写得太快".into()), cx)
    });
    assert!(wait_for(cx, |_| listed(&e).iter().any(|c| c["id"]
        == note.as_str()
        && c["body"] == "这里写得太快")));
    redraw(cx);
}

#[gpui::test]
fn the_arrow_opens_the_chapter_and_chooses_the_comment(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    let note = comment(&e, Some(&one), "note", "这里");
    let (view, opened, cx) = open_tab(cx, &e, None);
    assert!(wait_for(cx, |cx| ids(&view, cx).concat().len() == 1));
    cx.update(|window, cx| view.update(cx, |v, cx| v.jump(&note, window, cx)));
    cx.run_until_parked();
    assert_eq!(opened.borrow().as_slice(), [format!("chapter:{one}")]);
    let jump = cx.update(|_, cx| ReviewFocus::get(cx).jump.map(|j| j.comment));
    assert_eq!(jump.as_deref(), Some(note.as_str()));
}

#[gpui::test]
fn the_composer_writes_a_comment_on_the_selection(cx: &mut TestAppContext) {
    let e = env();
    let one = chapter(&e, "一", "雨夜，钟楼停了。");
    cx.executor().allow_parking();
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), format!("node:{one}"));
    let (editor, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    cx.run_until_parked();
    // No selection, no composer.
    let ws = e.ws.clone();
    let none = cx.update(|window, cx| {
        CommentComposer::for_selection(&editor, ws.clone(), Locale::ZhCn, window, cx)
    });
    assert!(none.is_none());
    let prose = editor.read_with(cx, |e, _| e.editor().clone());
    prose.update_in(cx, |p, window, cx| p.select(0, 3..5, window, cx));
    redraw(cx);
    let composer = cx
        .update(|window, cx| CommentComposer::for_selection(&editor, ws, Locale::ZhCn, window, cx))
        .expect("a composer for the selection");
    composer.update(cx, |c, cx| {
        c.set_todo(true, cx);
        c.set_text("钟楼要写清楚", cx);
        c.save(cx);
    });
    assert!(wait_for(cx, |_| listed(&e).len() == 1));
    let made = &listed(&e)[0];
    assert_eq!(made["kind"], "todo");
    assert_eq!(made["body"], "钟楼要写清楚");
    assert_eq!(made["anchored"], true);
    // Written: chosen, so the editor draws its sand along its rows.
    let jump = cx.update(|_, cx| ReviewFocus::get(cx).jump.map(|j| j.comment));
    assert_eq!(jump.as_deref(), made["id"].as_str());
}

#[gpui::test]
fn the_shortcut_is_a_keystroke_gpui_takes(cx: &mut TestAppContext) {
    // `KeyBinding::new` panics on a keystroke it cannot read.
    cx.update(|cx| cx.bind_keys(dr_view_review::bindings()));
}
