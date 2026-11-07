//! The editor's helpers around typing on a real workspace: automatic entity
//! links and their repair, the @ picker, the slash menu, the selection bar.

use std::time::Duration;

use dr_editor::assist::{BlockChoice, MenuKind, MenuRow};
use dr_editor::{ChapterEditor, ChapterEditorEvent, EditorSettings};
use dr_store::Library;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, EntityInputHandler, Focusable, TestAppContext, VisualTestContext, px, size};
use gpui_prose::ProseEditor;
use gpui_prose::input::actions::{Backspace, Newline, Undo};
use gpui_prose::text::BlockKind;
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
    let book = out(&ws, "book.create", json!({"name": "助手"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env {
        _dir: dir,
        ws,
        book,
    }
}

fn element(e: &Env, name: &str, aliases: &[&str]) -> String {
    out(
        &e.ws,
        "element.create",
        json!({"book": e.book, "name": name, "aliases": aliases}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
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

struct Open<'a> {
    view: Entity<ChapterEditor>,
    editor: Entity<ProseEditor>,
    cx: &'a mut VisualTestContext,
}

fn open<'a>(cx: &'a mut TestAppContext, e: &Env, doc: &str) -> Open<'a> {
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap()
    });
    cx.simulate_resize(size(px(900.), px(800.)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let focus = editor.read_with(cx, |e, cx| e.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    draw(cx);
    Open { view, editor, cx }
}

impl Open<'_> {
    fn caret(&mut self, at: usize) {
        self.editor
            .update_in(self.cx, |e, window, cx| e.select(0, at..at, window, cx));
    }

    fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            let s = c.to_string();
            self.editor.update_in(self.cx, |e, window, cx| {
                e.replace_text_in_range(None, &s, window, cx)
            });
        }
        draw(self.cx);
    }

    fn text(&mut self) -> String {
        self.view.read_with(self.cx, |v, cx| v.plain_text(cx))
    }

    fn linked(&mut self, at: usize, target: &str) -> bool {
        let key = gpui_prose::schema::inline::entity_key(target);
        self.editor
            .update(self.cx, |e, _| e.marks_at(0, at).has(&key))
    }

    fn wait_links(&mut self) {
        self.cx
            .executor()
            .advance_clock(dr_editor::assist::LINK_DELAY + Duration::from_millis(20));
        draw(self.cx);
    }

    fn menu(&mut self) -> Option<(MenuKind, String, Vec<MenuRow>)> {
        let assist = self.view.read_with(self.cx, |v, _| v.assist().clone());
        assist.read_with(self.cx, |a, _| {
            a.menu().map(|m| (m.kind, m.query.clone(), m.rows.clone()))
        })
    }

    fn action(&mut self, action: impl gpui::Action) {
        self.cx.dispatch_action(action);
        draw(self.cx);
    }
}

#[gpui::test]
fn typed_names_link_themselves_and_undo_with_the_typing(cx: &mut TestAppContext) {
    let e = env();
    let ye = element(&e, "叶青知", &[]);
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("叶青知到了。");
    assert!(!o.linked(0, &ye), "not before the pause");
    o.wait_links();
    assert!(o.linked(0, &ye) && o.linked(2, &ye) && !o.linked(3, &ye));
    // Stored: a fresh session on the document reads the link.
    let fresh = gpui_prose::ProseDoc::open(Box::new(
        dr_editor::SessionSource::open(&e.ws, &doc).unwrap(),
    ));
    assert!(
        fresh
            .marks_before(1)
            .has(&gpui_prose::schema::inline::entity_key(&ye))
    );
    // One undo takes back the typing and its link together.
    o.action(Undo);
    assert_eq!(o.text(), "\n");
}

#[gpui::test]
fn a_broken_name_loses_its_link(cx: &mut TestAppContext) {
    let e = env();
    let yue = element(&e, "约格", &["老约"]);
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("约格来了");
    o.wait_links();
    assert!(o.linked(0, &yue));
    // Delete 格: 约 is no name of the element, the link comes off.
    o.caret(2);
    o.action(Backspace);
    assert_eq!(o.text(), "约来了\n");
    assert!(!o.linked(0, &yue));
}

#[gpui::test]
fn the_at_picker_inserts_a_link(cx: &mut TestAppContext) {
    let e = env();
    let yue = element(&e, "约格", &["老约"]);
    element(&e, "叶青", &[]);
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("见@约");
    let (kind, query, rows) = o.menu().expect("the picker is open");
    assert_eq!((kind, query.as_str()), (MenuKind::Mention, "约"));
    let names: Vec<String> = rows
        .iter()
        .map(|r| match r {
            MenuRow::Link { name, .. } => name.clone(),
            MenuRow::Create { name } => format!("+{name}"),
            MenuRow::Block(_) => String::new(),
        })
        .collect();
    assert_eq!(names, ["约格", "老约", "+约"]);
    // Enter chooses the current row.
    o.action(Newline);
    assert_eq!(o.text(), "见约格 \n");
    assert!(o.linked(1, &yue) && o.linked(2, &yue) && !o.linked(3, &yue));
    assert!(o.menu().is_none());
    // One undo brings the typed query back.
    o.action(Undo);
    assert_eq!(o.text(), "见@约\n");
}

#[gpui::test]
fn the_picker_creates_an_element(cx: &mut TestAppContext) {
    let e = env();
    out(
        &e.ws,
        "category.create",
        json!({"book": e.book, "name": "人物"}),
    );
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("@沈知微");
    let rows = o.menu().unwrap().2;
    assert_eq!(
        rows.last(),
        Some(&MenuRow::Create {
            name: "沈知微".into()
        })
    );
    let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
    let last = rows.len() - 1;
    assist.update_in(o.cx, |a, window, cx| a.choose(Some(last), window, cx));
    draw(o.cx);
    let elements = out(&e.ws, "element.list", json!({"book": e.book}));
    let made = elements
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "沈知微")
        .expect("created")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(o.text(), "沈知微 \n");
    assert!(o.linked(0, &made));
}

#[gpui::test]
fn esc_closes_the_picker_until_the_trigger_goes(cx: &mut TestAppContext) {
    let e = env();
    element(&e, "约格", &[]);
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("@约");
    assert!(o.menu().is_some());
    o.cx.simulate_keystrokes("escape");
    draw(o.cx);
    assert!(o.menu().is_none());
    assert_eq!(o.text(), "@约\n", "the text stays");
    o.type_text("格");
    assert!(o.menu().is_none(), "stays closed");
    o.type_text(" @");
    assert!(o.menu().is_some(), "a new trigger opens it");
}

#[gpui::test]
fn the_slash_menu_turns_the_paragraph(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "一", "");
    let mut o = open(cx, &e, &doc);
    o.caret(0);
    o.type_text("码头/h2");
    let rows = o.menu().unwrap().2;
    assert_eq!(rows, [MenuRow::Block(BlockChoice::H2)]);
    o.action(Newline);
    assert_eq!(o.text(), "码头\n");
    let kind = o
        .editor
        .update(o.cx, |e, _| e.book().chapters[0].doc.line(0).kind);
    assert_eq!(kind, BlockKind::H2);
    // A rule where the caret is, the caret after it.
    o.caret(2);
    o.type_text("/分隔");
    o.action(Newline);
    let (lines, rule, head) = o.editor.update(o.cx, |e, _| {
        let doc = &e.book().chapters[0].doc;
        (
            doc.visible_lines(),
            doc.line(1)
                .block
                .get(gpui_prose::schema::block::RULE)
                .is_some(),
            e.selection().head,
        )
    });
    let attrs: Vec<String> = o.editor.update(o.cx, |e, _| {
        let doc = &e.book().chapters[0].doc;
        (0..doc.visible_lines())
            .map(|ix| format!("{:?}", doc.line(ix).block))
            .collect()
    });
    assert_eq!(o.text(), "码头\n\n\n");
    assert!(rule && lines == 3, "{lines} {attrs:?}");
    assert_eq!(head, 4, "the caret on the paragraph after the rule");
}

#[gpui::test]
fn the_selection_bar_shows_once_the_selection_settles(cx: &mut TestAppContext) {
    let e = env();
    let doc = chapter(&e, "一", "雨夜里钟停了。");
    let mut o = open(cx, &e, &doc);
    let assist = o.view.read_with(o.cx, |v, _| v.assist().clone());
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 0..2, window, cx));
    draw(o.cx);
    assert!(
        assist.read_with(o.cx, |a, _| a.bar().is_none()),
        "not at once"
    );
    o.cx.executor()
        .advance_clock(dr_editor::assist::BAR_DELAY + Duration::from_millis(20));
    draw(o.cx);
    assert_eq!(
        assist.read_with(o.cx, |a, _| a.bar().cloned()),
        Some((0, 0..2))
    );
    // Bold from the bar; the bar goes, the selection stays.
    assist.update_in(o.cx, |a, window, cx| {
        a.bar_mark(gpui_prose::schema::inline::BOLD, window, cx)
    });
    assert!(o.editor.update(o.cx, |e, _| e.marks_at(0, 0).has("bold")));
    assert!(assist.read_with(o.cx, |a, _| a.bar().is_none()));
    // Quote from the bar.
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 0..2, window, cx));
    o.cx.executor()
        .advance_clock(dr_editor::assist::BAR_DELAY + Duration::from_millis(20));
    draw(o.cx);
    assist.update_in(o.cx, |a, window, cx| {
        a.bar_block(BlockChoice::Quote, window, cx)
    });
    let quoted = o.editor.update(o.cx, |e, _| {
        e.book().chapters[0]
            .doc
            .line(0)
            .block
            .get(gpui_prose::schema::block::QUOTE)
            .is_some()
    });
    assert!(quoted);
    // 添加批注: the host hears where.
    let heard = std::rc::Rc::new(std::cell::RefCell::new(None));
    {
        let heard = heard.clone();
        o.cx.update(|_, cx| {
            cx.subscribe(&o.view, move |_, event: &ChapterEditorEvent, _| {
                if let ChapterEditorEvent::CommentRequested { range, text } = event {
                    *heard.borrow_mut() = Some((range.clone(), text.clone()));
                }
            })
            .detach();
        });
    }
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 2..4, window, cx));
    o.cx.executor()
        .advance_clock(dr_editor::assist::BAR_DELAY + Duration::from_millis(20));
    draw(o.cx);
    assist.update(o.cx, |a, cx| a.bar_comment(cx));
    assert_eq!(*heard.borrow(), Some((2..4, "里钟".to_owned())));
    // Typing hides the bar.
    o.editor
        .update_in(o.cx, |e, window, cx| e.select(0, 0..2, window, cx));
    o.cx.executor()
        .advance_clock(dr_editor::assist::BAR_DELAY + Duration::from_millis(20));
    draw(o.cx);
    assert!(assist.read_with(o.cx, |a, _| a.bar().is_some()));
    o.type_text("夜");
    assert!(assist.read_with(o.cx, |a, _| a.bar().is_none()));
}
