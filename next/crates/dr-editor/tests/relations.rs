//! RL (`kernel-v5.md` §19): relations in the prose on a real workspace. A
//! link's hover card brings the lines between the related names on screen;
//! its 「建关系」 opens the composer, which places a pair with
//! `relation_row.create_pair` and tells the host the row.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use dr_editor::assist::relate::{Dir, Drawn, RelationFocus};
use dr_editor::assist::{Assist, AssistEvent};
use dr_editor::decor::DecorLooks;
use dr_editor::{BookEditor, ChapterEditor, EditorSettings};
use dr_store::Library;
use dr_ui::tokens::Palette;
use dr_workspace::{Actor, Workspace, WorkspaceOptions, library_options};
use gpui::{Entity, Focusable as _, TestAppContext, VisualTestContext, hsla, px, size};
use gpui_prose::ProseEditor;
use gpui_prose::render::{DecorationEvent, DecorationKey};
use serde_json::{Value, json};

struct Env {
    dir: tempfile::TempDir,
    ws: Workspace,
    book: String,
}

fn out_as(actor: &Actor, ws: &Workspace, name: &str, input: Value) -> Value {
    ws.call(actor, name, input)
        .unwrap_or_else(|e| panic!("{name}: {e}"))["output"]
        .clone()
}

fn out(ws: &Workspace, name: &str, input: Value) -> Value {
    out_as(&Actor::User, ws, name, input)
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let lib = Library::open(dir.path(), library_options("test")).unwrap();
    let ws = Workspace::open(lib, WorkspaceOptions::default()).unwrap();
    let book = out(&ws, "project.create", json!({"name": "未庄"}))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Env { dir, ws, book }
}

fn element(e: &Env, name: &str) -> String {
    dr_testkit::seed::acceptance::novel_entry(&e.ws, &e.book, "tpl-character", name, None)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A chapter whose paragraphs are `text`, the names in it linked (written
/// as the Markdown folder writes, which links what it writes).
fn chapter(e: &Env, title: &str, text: &[&str]) -> String {
    let root = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript");
    let id = out(
        &e.ws,
        "entry.create",
        json!({"book": e.book, "parent": root, "template": "tpl-chapter", "title": title}),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    out_as(
        &Actor::Mirror,
        &e.ws,
        "module.set_prose",
        json!({"book": e.book, "owner": id, "module": "mod-prose",
            "paragraphs": text.iter().map(|t| json!({"text": t})).collect::<Vec<_>>()}),
    );
    format!("body:{id}/mod-prose")
}

fn relation_id(e: &Env, name: &str) -> Option<String> {
    out(&e.ws, "relation_type.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .map(|r| r["id"].as_str().unwrap().to_owned())
}

/// Relates `left` to `right` by `name` (made, `symmetric` or not, the first
/// time). The row's id.
fn relate(e: &Env, left: &str, right: &str, name: &str, symmetric: bool) -> String {
    let mut input = json!({"book": e.book, "left": left, "right": right});
    match relation_id(e, name) {
        Some(id) => input["relation_type"] = id.into(),
        None => {
            input["new_type"] = json!({"name": name,
                "direction": if symmetric { "symmetric" } else { "directed" }})
        }
    }
    out(&e.ws, "relation_row.create_pair", input)["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn rows_of(e: &Env, name: &str) -> Vec<Value> {
    out(&e.ws, "relation_type.list", json!({"book": e.book}))
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == name)
        .map(|r| r["rows"].as_array().unwrap().clone())
        .unwrap_or_default()
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn looks() -> DecorLooks {
    DecorLooks::new(&Palette::LIGHT, hsla(0.58, 0.7, 0.42, 1.), false)
}

struct Open<'a> {
    editor: Entity<ProseEditor>,
    assist: Entity<Assist>,
    cx: &'a mut VisualTestContext,
}

fn open<'a>(cx: &'a mut TestAppContext, e: &Env, doc: &str, height: f32) -> Open<'a> {
    let (ws, book, doc) = (e.ws.clone(), e.book.clone(), doc.to_owned());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut editor =
            ChapterEditor::open(ws, &book, &doc, EditorSettings::default(), window, cx).unwrap();
        editor.set_decor_looks(looks(), cx);
        editor
    });
    cx.simulate_resize(size(px(900.), px(height)));
    draw(cx);
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let assist = view.read_with(cx, |v, _| v.assist().clone());
    let focus = editor.read_with(cx, |e, cx| e.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    draw(cx);
    let mut o = Open { editor, assist, cx };
    o.settle();
    o
}

impl Open<'_> {
    fn settle(&mut self) {
        self.cx
            .executor()
            .advance_clock(Duration::from_millis(400));
        draw(self.cx);
        draw(self.cx);
    }

    /// Rests the pointer on link `id` of `chapter` until its card opens.
    fn point(&mut self, chapter: usize, id: &str) {
        let key = DecorationKey {
            group: "links".into(),
            id: id.to_owned().into(),
        };
        self.editor.update(self.cx, |_, cx| {
            cx.emit(DecorationEvent::Pointed {
                ids: vec![(chapter, key)],
            })
        });
        self.cx
            .executor()
            .advance_clock(Duration::from_millis(260));
        draw(self.cx);
        draw(self.cx);
        assert!(
            self.assist.read_with(self.cx, |a, _| a.card().is_some()),
            "the card of {id} is open"
        );
    }

    fn leave(&mut self) {
        self.editor.update(self.cx, |_, cx| {
            cx.emit(DecorationEvent::Pointed { ids: Vec::new() })
        });
        self.cx
            .executor()
            .advance_clock(Duration::from_millis(400));
        draw(self.cx);
        draw(self.cx);
    }

    fn drawn(&mut self) -> Option<Drawn> {
        self.assist.read_with(self.cx, |a, _| a.relation_drawn().cloned())
    }

    /// The lines drawn, each as its two entries (sorted) and its names.
    fn lines(&mut self) -> Vec<((String, String), Vec<String>)> {
        let mut out: Vec<_> = self
            .drawn()
            .map(|d| d.lines)
            .unwrap_or_default()
            .into_iter()
            .map(|l| {
                let mut ends = [l.a.entry.clone(), l.b.entry.clone()];
                ends.sort();
                (
                    (ends[0].clone(), ends[1].clone()),
                    l.labels.iter().map(|x| x.name.clone()).collect(),
                )
            })
            .collect();
        out.sort();
        out
    }

    fn placed(&mut self) -> Rc<RefCell<Vec<String>>> {
        let rows = Rc::new(RefCell::new(Vec::new()));
        let sink = rows.clone();
        let assist = self.assist.clone();
        self.cx.update(|_, cx| {
            cx.subscribe(&assist, move |_, e: &AssistEvent, _| {
                if let AssistEvent::RelationPlaced { row } = e {
                    sink.borrow_mut().push(row.clone());
                }
            })
            .detach();
        });
        rows
    }

    fn start(&mut self) {
        self.assist
            .update_in(self.cx, |a, window, cx| a.start_relation(window, cx));
        draw(self.cx);
        draw(self.cx);
    }

    fn commit(&mut self) -> bool {
        let done = self
            .assist
            .update_in(self.cx, |a, window, cx| a.relation_commit(window, cx));
        draw(self.cx);
        done
    }
}

fn pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.into(), b.into())
    } else {
        (b.into(), a.into())
    }
}

#[gpui::test]
fn the_card_brings_lines_between_every_related_pair_on_screen(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    let xd = element(&e, "小D");
    let zt = element(&e, "赵太爷");
    relate(&e, &aq, &wh, "冤家", true);
    relate(&e, &wh, &aq, "欺辱", false);
    relate(&e, &aq, &xd, "冤家", true);
    relate(&e, &wh, &xd, "同伙", true);
    let doc = chapter(
        &e,
        "一",
        &[
            "阿Q看见王胡在墙根的日光下捉虱子。",
            "小D和王胡在钱府的照壁前面打架，赵太爷远远地看着。",
        ],
    );
    let mut o = open(cx, &e, &doc, 800.);
    assert!(o.drawn().is_none(), "no lines while nothing is pointed at");
    // l0 阿Q, l1 王胡, l2 小D, l3 王胡, l4 赵太爷.
    o.point(0, "l0");
    let lines = o.lines();
    assert_eq!(
        lines,
        {
            let mut want = vec![
                (pair(&aq, &wh), vec!["冤家".to_owned(), "欺辱".to_owned()]),
                (pair(&aq, &xd), vec!["冤家".to_owned()]),
                (pair(&wh, &xd), vec!["同伙".to_owned()]),
            ];
            want.sort();
            want
        },
        "one line per pair, two relations on one line, lines between other names too; 赵太爷 has none"
    );
    let drawn = o.drawn().unwrap();
    // The directed name points at 阿Q; the symmetric one at nothing.
    let aq_wh = drawn
        .lines
        .iter()
        .find(|l| pair(&l.a.entry, &l.b.entry) == pair(&aq, &wh))
        .unwrap();
    let bully = aq_wh.labels.iter().find(|l| l.name == "欺辱").unwrap();
    assert_eq!(bully.to.as_deref(), Some(aq.as_str()));
    assert!(aq_wh.labels.iter().any(|l| l.name == "冤家" && l.to.is_none()));
    // The pointed 阿Q is joined where it is pointed; 王胡 at its nearer place.
    assert_eq!(aq_wh.a.id.as_ref() == "l0" || aq_wh.b.id.as_ref() == "l0", true);
    assert!(
        aq_wh.a.id.as_ref() == "l1" || aq_wh.b.id.as_ref() == "l1",
        "the 王胡 on the pointed row"
    );
    // The names sit on blanks between rows, never on words.
    for line in &drawn.lines {
        let (x, y) = line.label_at;
        assert!(
            drawn.blanks.iter().any(|b| (b - y).abs() < 0.01),
            "on a blank: {y} of {:?}",
            drawn.blanks
        );
        for n in &drawn.joined {
            let r = n.rect;
            let inside = x >= f32::from(r.left())
                && x <= f32::from(r.right())
                && y > f32::from(r.top())
                && y < f32::from(r.bottom());
            assert!(!inside, "a relation's name is not on a name");
        }
    }
    // Every joined name has its stroke; 赵太爷 is not joined.
    assert!(drawn.joined.iter().all(|n| n.entry != zt));
    // The card goes and its lines with it.
    o.leave();
    assert!(o.assist.read_with(o.cx, |a, _| a.card().is_none()));
    assert!(o.drawn().is_none(), "the lines went with the card");
}

#[gpui::test]
fn a_name_named_twice_is_joined_at_the_nearer_place(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    relate(&e, &aq, &wh, "冤家", true);
    let doc = chapter(
        &e,
        "一",
        &[
            "阿Q在土谷祠里睡了一夜。",
            "第二天的太阳照常升起，街上的人照常走来走去。",
            "酒店里的人照常说笑，没有谁记得昨天的事。",
            "王胡在墙根捉虱子，阿Q便在他旁边坐下。",
        ],
    );
    let mut o = open(cx, &e, &doc, 800.);
    // l0 阿Q (first row), l1 王胡, l2 阿Q (beside 王胡).
    o.point(0, "l1");
    let drawn = o.drawn().unwrap();
    assert_eq!(drawn.lines.len(), 1, "one line for the pair");
    let line = &drawn.lines[0];
    let aq_end = if line.a.entry == aq { &line.a } else { &line.b };
    assert_eq!(aq_end.id.as_ref(), "l2", "the 阿Q nearer the pointed 王胡");
    assert_eq!(
        drawn.joined.iter().filter(|n| n.entry == aq).count(),
        1,
        "one place only"
    );
}

#[gpui::test]
fn a_name_scrolled_away_loses_its_line(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    let xd = element(&e, "小D");
    relate(&e, &aq, &wh, "冤家", true);
    relate(&e, &aq, &xd, "冤家", true);
    let filler = "未庄的日子一天一天过去，谁也说不清楚今天和昨天有什么两样，街上的人照常走来走去。";
    let mut text = vec!["王胡在墙根。"];
    text.extend(std::iter::repeat_n(filler, 3));
    text.push("阿Q看见了小D。");
    text.extend(std::iter::repeat_n(filler, 30));
    chapter(&e, "一", &text);
    // The whole book scrolls in its own view (a body scrolls with its page).
    let mut o = open_book(cx, &e, 640.);
    let ch = first_linked_chapter(&mut o);
    // l0 王胡, l1 阿Q, l2 小D.
    o.point(ch, "l1");
    assert_eq!(o.lines().len(), 2, "both lines while both names show");
    let top = |o: &mut Open| {
        o.drawn()
            .unwrap()
            .joined
            .iter()
            .find(|n| n.entry == wh)
            .map(|n| f32::from(n.rect.top()))
    };
    let wh_top = top(&mut o).expect("王胡 is joined");
    // Scroll until 王胡's row is out of view (阿Q and 小D still in).
    o.editor.update(o.cx, |p, cx| {
        p.scroll_by_estimate(f64::from(wh_top) + 40., cx);
    });
    draw(o.cx);
    draw(o.cx);
    let lines = o.lines();
    assert_eq!(
        lines,
        vec![(pair(&aq, &xd), vec!["冤家".to_owned()])],
        "王胡 went out of view and its line with it"
    );
}

#[gpui::test]
fn the_composer_places_a_pair_picked_in_the_prose_in_the_row_it_belongs_to(
    cx: &mut TestAppContext,
) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    let xn = element(&e, "小尼姑");
    // 「欺辱」: 阿Q → 王胡 already; picking 小尼姑 joins that row's right.
    let row = relate(&e, &aq, &wh, "欺辱", false);
    let doc = chapter(
        &e,
        "一",
        &["阿Q打了王胡。", "对面走来了静修庵里的小尼姑。"],
    );
    let mut o = open(cx, &e, &doc, 800.);
    let placed = o.placed();
    o.point(0, "l0");
    o.start();
    assert!(o.assist.read_with(o.cx, |a, _| a.card().is_none()), "the card went");
    let state = o.assist.update(o.cx, |a, _| a.compose_state()).unwrap();
    assert_eq!(state.src, aq);
    assert!(!state.ready);
    assert_eq!(state.names, vec![("欺辱".to_owned(), false)]);
    // Every other name on screen is outlined to be picked; the lines stay.
    let drawn = o.drawn().unwrap();
    assert!(drawn.picks.iter().any(|n| n.entry == xn));
    assert!(drawn.picks.iter().all(|n| n.id.as_ref() != "l0"));
    assert_eq!(drawn.lines.len(), 1);
    // A click on 小尼姑 (its outline's handler), then the used name.
    let at = drawn.picks.iter().find(|n| n.entry == xn).unwrap().clone();
    o.assist.update(o.cx, |a, cx| {
        a.relation_pick(&xn, Some((at.chapter, at.id.clone())), cx)
    });
    o.assist.update(o.cx, |a, cx| a.set_relation_name("欺辱", cx));
    draw(o.cx);
    let state = o.assist.update(o.cx, |a, _| a.compose_state()).unwrap();
    assert_eq!(state.dst.as_deref(), Some(xn.as_str()));
    assert_eq!(state.names, vec![("欺辱".to_owned(), true)], "the chosen name lit");
    assert!(state.ready);
    let pending = o.drawn().unwrap().pending.unwrap();
    assert_eq!((pending.0.entry.as_str(), pending.1.entry.as_str()), (aq.as_str(), xn.as_str()));
    assert!(o.commit());
    assert!(o.assist.update(o.cx, |a, _| a.compose_state()).is_none(), "the bar went");
    // Rule 1: the row whose left is only 阿Q took 小尼姑 on its right.
    let rows = rows_of(&e, "欺辱");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], row.as_str());
    let right: Vec<&str> = rows[0]["right"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(right.contains(&xn.as_str()) && right.contains(&wh.as_str()));
    assert_eq!(*placed.borrow(), vec![row.clone()], "the host is told the row");
    // The new pair's lines stay a moment.
    let lines = o.lines();
    assert!(lines.contains(&(pair(&aq, &xn), vec!["欺辱".to_owned()])));
    o.cx.executor().advance_clock(dr_editor::assist::relate::LINGER);
    draw(o.cx);
    draw(o.cx);
    assert!(o.drawn().is_none(), "then go");
    // One undo step takes the pair back out.
    assert!(e.ws.undo_in(&Actor::User, &e.book, None).unwrap().is_some());
    let right: Vec<String> = rows_of(&e, "欺辱")[0]["right"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(right, vec![wh.clone()]);
}

#[gpui::test]
fn the_at_field_finds_an_entry_off_screen_and_a_new_name_makes_a_relation(
    cx: &mut TestAppContext,
) {
    let e = env();
    let aq = element(&e, "阿Q");
    let _wh = element(&e, "王胡");
    let xd = element(&e, "小D");
    let doc = chapter(&e, "一", &["阿Q看见王胡。"]);
    let mut o = open(cx, &e, &doc, 800.);
    let placed = o.placed();
    o.point(0, "l0");
    o.start();
    assert!(
        o.assist.update(o.cx, |a, _| a.compose_state()).unwrap().names.is_empty(),
        "no relation yet: no row of names"
    );
    // 小D is in no text on screen; the @ field finds it.
    o.assist.update(o.cx, |a, cx| a.set_relation_query("小", cx));
    let state = o.assist.update(o.cx, |a, _| a.compose_state()).unwrap();
    assert_eq!(state.candidates, vec![xd.clone()]);
    o.assist.update(o.cx, |a, cx| a.relation_pick(&xd, None, cx));
    // A new name: the direction steps → ← ↔.
    o.assist.update(o.cx, |a, cx| a.set_relation_name("同乡", cx));
    let dirs: Vec<Dir> = (0..3)
        .map(|_| {
            o.assist.update(o.cx, |a, cx| {
                a.relation_flip(cx);
                a.compose_state().unwrap().dir
            })
        })
        .collect();
    assert_eq!(dirs, [Dir::From, Dir::Both, Dir::To]);
    o.assist.update(o.cx, |a, cx| a.relation_flip(cx));
    o.assist.update(o.cx, |a, cx| a.relation_flip(cx));
    assert!(o.commit());
    let made = out(&e.ws, "relation_type.list", json!({"book": e.book}));
    let made = made.as_array().unwrap();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0]["name"], "同乡");
    assert_eq!(made[0]["direction"], "symmetric");
    assert_eq!(made[0]["rows"][0]["left"][0], aq.as_str());
    assert_eq!(made[0]["rows"][0]["right"][0], xd.as_str());
    assert_eq!(*placed.borrow(), vec![made[0]["rows"][0]["id"].as_str().unwrap().to_owned()]);
    // Making the relation and its pair was one undo step.
    assert!(e.ws.undo_in(&Actor::User, &e.book, None).unwrap().is_some());
    assert!(
        out(&e.ws, "relation_type.list", json!({"book": e.book}))
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[gpui::test]
fn a_used_name_fixes_the_direction_and_an_existing_pair_is_not_written_again(
    cx: &mut TestAppContext,
) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    let xd = element(&e, "小D");
    let enemies = relate(&e, &aq, &wh, "冤家", true);
    relate(&e, &xd, &wh, "欺辱", false);
    let doc = chapter(&e, "一", &["阿Q看见王胡，小D也在。"]);
    let mut o = open(cx, &e, &doc, 800.);
    let placed = o.placed();
    o.point(0, "l0");
    o.start();
    o.assist.update(o.cx, |a, cx| a.relation_pick(&wh, None, cx));
    // A symmetric name: ↔ and the button does nothing.
    o.assist.update(o.cx, |a, cx| a.set_relation_name("冤家", cx));
    let s = o.assist.update(o.cx, |a, _| a.compose_state()).unwrap();
    assert_eq!((s.dir, s.dir_locked), (Dir::Both, true));
    o.assist.update(o.cx, |a, cx| a.relation_flip(cx));
    assert_eq!(o.assist.update(o.cx, |a, _| a.compose_state()).unwrap().dir, Dir::Both);
    // A directed name: only which end is left.
    o.assist.update(o.cx, |a, cx| a.set_relation_name("欺辱", cx));
    let s = o.assist.update(o.cx, |a, _| a.compose_state()).unwrap();
    assert_eq!((s.dir, s.dir_locked), (Dir::To, false));
    let dirs: Vec<Dir> = (0..2)
        .map(|_| {
            o.assist.update(o.cx, |a, cx| {
                a.relation_flip(cx);
                a.compose_state().unwrap().dir
            })
        })
        .collect();
    assert_eq!(dirs, [Dir::From, Dir::To]);
    // 阿Q ↔ 王胡 is already 冤家: nothing is written, the row is shown.
    o.assist.update(o.cx, |a, cx| a.set_relation_name("冤家", cx));
    let before = rows_of(&e, "冤家");
    assert!(o.commit());
    assert_eq!(rows_of(&e, "冤家"), before, "the pair was there: nothing written");
    assert_eq!(*placed.borrow(), vec![enemies]);
}

#[gpui::test]
fn esc_and_cancel_leave_the_composer(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    relate(&e, &aq, &wh, "冤家", true);
    let doc = chapter(&e, "一", &["阿Q看见王胡。"]);
    let mut o = open(cx, &e, &doc, 800.);
    o.point(0, "l0");
    o.start();
    assert!(o.assist.update(o.cx, |a, _| a.compose_state()).is_some());
    // While composing a name is picked, not carded.
    o.editor.update(o.cx, |_, cx| {
        cx.emit(DecorationEvent::Pointed {
            ids: vec![(
                0,
                DecorationKey {
                    group: "links".into(),
                    id: "l1".into(),
                },
            )],
        })
    });
    o.cx.executor().advance_clock(Duration::from_millis(300));
    draw(o.cx);
    assert!(o.assist.read_with(o.cx, |a, _| a.card().is_none()));
    o.assist.update(o.cx, |a, cx| a.dismiss(cx));
    draw(o.cx);
    assert!(o.assist.update(o.cx, |a, _| a.compose_state()).is_none(), "Esc");
    o.point(0, "l0");
    o.start();
    o.assist
        .update_in(o.cx, |a, window, cx| a.close_compose(window, cx));
    draw(o.cx);
    assert!(o.assist.update(o.cx, |a, _| a.compose_state()).is_none(), "取消");
    assert_eq!(rows_of(&e, "冤家").len(), 1, "nothing written");
}

#[gpui::test]
fn a_rail_row_pointed_at_draws_its_pairs(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    let xd = element(&e, "小D");
    let row = relate(&e, &aq, &wh, "冤家", true);
    relate(&e, &xd, &wh, "欺辱", false);
    let doc = chapter(&e, "一", &["阿Q、王胡和小D都在。"]);
    let mut o = open(cx, &e, &doc, 800.);
    o.cx.update(|_, cx| RelationFocus::point(Some(row.clone()), cx));
    draw(o.cx);
    draw(o.cx);
    assert_eq!(o.lines(), vec![(pair(&aq, &wh), vec!["冤家".to_owned()])]);
    o.cx.update(|_, cx| RelationFocus::point(None, cx));
    draw(o.cx);
    assert!(o.drawn().is_none());
}

#[gpui::test]
fn links_to_files_have_no_part_in_the_lines(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    relate(&e, &aq, &wh, "冤家", true);
    let bytes = {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 4, 4);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[90u8; 48])
            .unwrap();
        bytes
    };
    let file = e.dir.path().join("map.png");
    std::fs::write(&file, &bytes).unwrap();
    let asset = dr_model::id::new_uuid_v7();
    let record = e
        .ws
        .library()
        .import_asset(&dr_store::asset::SourceImport {
            book_id: &e.book,
            asset_id: &asset,
            source: &file,
            mime: "image/png",
            ext: "png",
            dimensions: Some((4, 4)),
            limit: 1 << 20,
        })
        .unwrap();
    out(
        &e.ws,
        "asset.put",
        json!({"book": e.book, "id": asset, "name": "地图", "kind": "image", "mime": "image/png",
            "size": bytes.len(), "sha256": record.sha256, "width": 4, "height": 4}),
    );
    let doc = chapter(&e, "一", &["阿Q看见王胡。"]);
    let mut o = open(cx, &e, &doc, 800.);
    // A file link at the end, through the @ picker.
    let end = o.editor.read_with(o.cx, |p, _| p.book().chapters[0].doc.len_chars());
    o.editor
        .update_in(o.cx, |p, window, cx| p.select(0, end - 1..end - 1, window, cx));
    for c in "@地图".chars() {
        let s = c.to_string();
        o.editor.update_in(o.cx, |p, window, cx| {
            gpui::EntityInputHandler::replace_text_in_range(p, None, &s, window, cx)
        });
    }
    draw(o.cx);
    o.cx.dispatch_action(gpui_prose::input::actions::Newline);
    o.settle();
    assert!(
        o.editor
            .read_with(o.cx, |p, _| p.decoration_range(0, "links", "f2").is_some()),
        "the file link is drawn as one"
    );
    o.point(0, "l0");
    let drawn = o.drawn().unwrap();
    assert_eq!(drawn.lines.len(), 1);
    assert!(
        drawn.joined.iter().chain(&drawn.picks).all(|n| n.id.starts_with('l')),
        "no file link among the names"
    );
    let _ = (aq, wh);
}

#[gpui::test]
fn the_whole_book_joins_names_across_chapters(cx: &mut TestAppContext) {
    let e = env();
    let aq = element(&e, "阿Q");
    let wh = element(&e, "王胡");
    relate(&e, &aq, &wh, "冤家", true);
    chapter(&e, "一", &["阿Q在土谷祠。"]);
    chapter(&e, "二", &["王胡在墙根。"]);
    let mut o = open_book(cx, &e, 900.);
    let ch = first_linked_chapter(&mut o);
    o.point(ch, "l0");
    let lines = o.lines();
    assert_eq!(lines, vec![(pair(&aq, &wh), vec!["冤家".to_owned()])]);
    let drawn = o.drawn().unwrap();
    assert_ne!(drawn.lines[0].a.chapter, drawn.lines[0].b.chapter, "across chapters");
}

fn open_book<'a>(cx: &'a mut TestAppContext, e: &Env, height: f32) -> Open<'a> {
    let root = dr_testkit::seed::acceptance::novel_root(&e.ws, &e.book, "tpl-manuscript");
    let (ws, book) = (e.ws.clone(), e.book.clone());
    cx.executor().allow_parking();
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut b =
            BookEditor::open(ws, &book, &root, EditorSettings::default(), window, cx).unwrap();
        b.set_decor_looks(looks(), cx);
        b
    });
    cx.simulate_resize(size(px(900.), px(height)));
    for _ in 0..4 {
        cx.executor().advance_clock(Duration::from_millis(400));
        draw(cx);
    }
    let editor = view.read_with(cx, |v, _| v.editor().clone());
    let assist = view.read_with(cx, |v, _| v.assist().clone());
    let focus = editor.read_with(cx, |p, cx| p.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    let mut o = Open { editor, assist, cx };
    o.settle();
    o
}

/// The first chapter of the book view with links painted.
fn first_linked_chapter(o: &mut Open) -> usize {
    o.editor.read_with(o.cx, |p, _| {
        p.painted_group("links")
            .into_iter()
            .map(|d| d.chapter)
            .min()
            .expect("links painted")
    })
}
