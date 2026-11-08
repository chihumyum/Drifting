//! The paint layers with GPUI's deterministic test platform: decorations
//! following edits, transitions on the executor's clock, the pointer, block
//! styles, immersive writing's focus and the scrollbar ticks.

use std::{cell::RefCell, rc::Rc, time::Duration};

use gpui::{
    Entity, EntityInputHandler, Modifiers, MouseButton, Pixels, Point, TestAppContext,
    VisualTestContext, hsla, point, px, size,
};
use loro::LoroValue;

use super::{
    blocks::Align,
    decor::{
        Decoration, DecorationEvent, DecorationKey, Emphasis, Look, Strength, Tick, TickLane,
        Touch, Underline, Wash,
    },
    motion,
    sand::SandTexture,
    state::FOCUS_DIM,
};
use crate::{
    ProseEditor, ProseStyle,
    layout::{Book, Chapter},
    schema::block,
    text::{BlockKind, ProseDoc},
};

const LONG: &str = "他把吸铁石拍在桌上，说这东西能把河里的铁钉都吸上来，谁也不信，可第二天一早，码头上围了一圈人，看他从水里一根一根地往外拽，拽到太阳落山，钉子堆得比他的膝盖还高。";

fn editor<'a>(
    cx: &'a mut TestAppContext,
    paragraphs: &[(BlockKind, &str)],
) -> (Entity<ProseEditor>, &'a mut VisualTestContext) {
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc: ProseDoc::from_paragraphs(paragraphs.iter().copied()),
    }]);
    let (editor, cx) =
        cx.add_window_view(|window, cx| ProseEditor::new(book, ProseStyle::default(), window, cx));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    (editor, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    cx.run_until_parked();
}

fn advance(cx: &mut VisualTestContext, by: Duration) {
    cx.executor().advance_clock(by);
    draw(cx);
}

fn comment(id: &str, range: std::ops::Range<usize>) -> Decoration {
    Decoration::new(
        id.to_string(),
        range,
        Look::Wash(Wash::flat(
            hsla(0., 0.6, 0.5, 1.),
            Strength::new(0.27, 0.61),
        )),
    )
}

fn set(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    group: &str,
    decorations: Vec<Decoration>,
) {
    let group = group.to_string();
    editor.update(cx, |editor, cx| {
        editor.set_decorations(0, group, decorations, cx)
    });
}

fn range(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    group: &str,
    id: &str,
) -> Option<std::ops::Range<usize>> {
    editor.update(cx, |editor, _| editor.decoration_range(0, group, id))
}

fn painted(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    group: &str,
    id: &str,
) -> Option<super::PaintedDecoration> {
    editor.update(cx, |editor, _| editor.painted_decoration(0, group, id))
}

fn type_at(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, at: usize, text: &str) {
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, at..at, window, cx);
        editor.replace_text_in_range(None, text, window, cx);
    });
}

fn events(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
) -> Rc<RefCell<Vec<DecorationEvent>>> {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let sink = seen.clone();
    cx.update(|_, cx| {
        cx.subscribe(editor, move |_, event: &DecorationEvent, _| {
            sink.borrow_mut().push(event.clone());
        })
        .detach();
    });
    seen
}

fn key(group: &str, id: &str) -> DecorationKey {
    DecorationKey {
        group: group.to_string().into(),
        id: id.to_string().into(),
    }
}

fn center(b: gpui::Bounds<Pixels>) -> Point<Pixels> {
    b.center()
}

// ----- moving with the text --------------------------------------------------------

#[gpui::test]
fn decorations_follow_typing_and_other_writes(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, "甲乙丙丁戊己")]);
    set(&editor, cx, "comments", vec![comment("c1", 2..4)]);
    // Typing before it moves it; typing right at its start stays outside.
    type_at(&editor, cx, 0, "子");
    assert_eq!(range(&editor, cx, "comments", "c1"), Some(3..5));
    type_at(&editor, cx, 3, "丑");
    assert_eq!(range(&editor, cx, "comments", "c1"), Some(4..6));
    // Typing inside grows it; right at its end stays outside.
    type_at(&editor, cx, 5, "寅");
    assert_eq!(range(&editor, cx, "comments", "c1"), Some(4..7));
    type_at(&editor, cx, 7, "卯");
    assert_eq!(range(&editor, cx, "comments", "c1"), Some(4..7));
    // Someone else's write (the Agent) moves it too, and undo of the
    // author's typing brings it back.
    editor.update(cx, |editor, cx| editor.agent_write(0, 0..0, "AB", "s1", cx));
    assert_eq!(range(&editor, cx, "comments", "c1"), Some(6..9));
    // Deleting its words collapses it: nothing is drawn.
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 5..10, window, cx);
        editor.press_backspace(window, cx);
    });
    assert_eq!(
        range(&editor, cx, "comments", "c1").map(|r| r.len()),
        Some(0)
    );
    advance(cx, motion::FADE);
    assert!(painted(&editor, cx, "comments", "c1").is_none());
}

#[gpui::test]
fn a_composition_shows_outside_a_decoration_it_starts_at(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, "甲乙丙丁")]);
    set(&editor, cx, "comments", vec![comment("c1", 1..3)]);
    advance(cx, motion::FADE);
    let before = painted(&editor, cx, "comments", "c1").unwrap().boxes[0];
    // Pinyin marked right at the decoration's start pushes it right.
    editor.update_in(cx, |editor, window, cx| {
        editor.select(0, 1..1, window, cx);
        editor.replace_and_mark_text_in_range(None, "ni", Some(2..2), window, cx);
    });
    draw(cx);
    let during = painted(&editor, cx, "comments", "c1").unwrap().boxes[0];
    assert!(
        during.left() > before.left() + px(4.),
        "{during:?} vs {before:?}"
    );
    assert!((f32::from(during.size.width) - f32::from(before.size.width)).abs() < 1.);
}

// ----- painting and transitions ----------------------------------------------------

#[gpui::test]
fn a_wash_covers_each_row_and_fades_in(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, LONG)]);
    let len = LONG.chars().count();
    set(&editor, cx, "comments", vec![comment("c1", 3..len - 3)]);
    draw(cx);
    assert!(
        painted(&editor, cx, "comments", "c1").is_none(),
        "a new decoration starts invisible"
    );
    advance(cx, motion::FADE / 2);
    let first = painted(&editor, cx, "comments", "c1").unwrap();
    assert!(
        first.boxes.len() >= 2,
        "a long range covers several rows: {first:?}"
    );
    // Rows run top to bottom.
    for pair in first.boxes.windows(2) {
        assert!(pair[1].top() > pair[0].top());
    }
    let mid = first.alpha;
    assert!(mid > 0. && mid < 0.27, "{mid}");
    advance(cx, motion::FADE);
    let rest = painted(&editor, cx, "comments", "c1").unwrap().alpha;
    assert!((rest - 0.27).abs() < 1e-4, "{rest}");
    // Pointed at from its card: stronger, eased over 0.24 s.
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 3..len - 3).emphasis(Emphasis::Hot)],
    );
    advance(cx, motion::SHIFT / 2);
    let shifting = painted(&editor, cx, "comments", "c1").unwrap().alpha;
    assert!(shifting > 0.27 && shifting < 0.61, "{shifting}");
    advance(cx, motion::SHIFT);
    let hot = painted(&editor, cx, "comments", "c1").unwrap().alpha;
    assert!((hot - 0.61).abs() < 1e-4, "{hot}");
    // Resolved: it fades out as a whole, then is gone.
    set(&editor, cx, "comments", vec![]);
    advance(cx, motion::FADE / 2);
    assert!(painted(&editor, cx, "comments", "c1").unwrap().alpha > 0.);
    advance(cx, motion::FADE);
    assert!(painted(&editor, cx, "comments", "c1").is_none());
}

#[gpui::test]
fn a_drawn_decoration_is_drawn_along_its_rows_then_settles(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, LONG), (BlockKind::Body, "后一段")]);
    let seen = events(&editor, cx);
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 0..40).emphasis(Emphasis::Drawn(1))],
    );
    let start = painted(&editor, cx, "comments", "c1").unwrap();
    assert_eq!(start.drawn, Some(0.));
    // Arriving by being drawn, not by fading: full strength at once.
    assert!((start.alpha - 0.61).abs() < 1e-4, "{}", start.alpha);
    advance(cx, Duration::from_millis(150));
    let partway = painted(&editor, cx, "comments", "c1")
        .unwrap()
        .drawn
        .unwrap();
    assert!(partway > 0.2 && partway < 1., "{partway}");
    advance(cx, Duration::from_secs(1));
    assert_eq!(painted(&editor, cx, "comments", "c1").unwrap().drawn, None);
    // The same number again does not draw it again.
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 0..40).emphasis(Emphasis::Drawn(1))],
    );
    draw(cx);
    assert_eq!(painted(&editor, cx, "comments", "c1").unwrap().drawn, None);
    // The author types: it settles back to rest and the host hears so.
    let end = LONG.chars().count();
    type_at(&editor, cx, end + 1, "字");
    advance(cx, motion::SHIFT);
    let rest = painted(&editor, cx, "comments", "c1").unwrap().alpha;
    assert!((rest - 0.27).abs() < 1e-4, "{rest}");
    assert!(seen.borrow().contains(&DecorationEvent::Settled {
        chapter: 0,
        key: key("comments", "c1"),
    }));
    // A new number draws it again; a click in the prose settles it.
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 0..40).emphasis(Emphasis::Drawn(2))],
    );
    advance(cx, Duration::from_secs(1));
    let line = editor.update(cx, |e, _| e.frame.borrow().lines[1].bounds);
    cx.simulate_click(center(line), Modifiers::default());
    advance(cx, motion::SHIFT);
    let settled = seen
        .borrow()
        .iter()
        .filter(|e| matches!(e, DecorationEvent::Settled { .. }))
        .count();
    assert_eq!(settled, 2);
}

#[gpui::test]
fn reduced_motion_lands_at_once(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, "甲乙丙丁")]);
    editor.update(cx, |editor, cx| editor.set_reduce_motion(true, cx));
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 0..2).emphasis(Emphasis::Drawn(1))],
    );
    draw(cx);
    let p = painted(&editor, cx, "comments", "c1").unwrap();
    assert_eq!(p.drawn, None);
    assert!((p.alpha - 0.61).abs() < 1e-4);
}

#[gpui::test]
fn underlines_inks_and_sand_textures_paint(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, "林岚把吸铁石拍在桌上")]);
    let grains: String = (0..40)
        .map(|i| {
            format!(
                r#"<circle cx="{}" cy="{}" r="2" fill="white"/>"#,
                i * 18 + 4,
                6 + (i * 7) % 14
            )
        })
        .collect();
    let ul = Rc::new(SandTexture::from_svg("test/ul", 720., 26., grains));
    let blue = hsla(0.6, 0.6, 0.4, 1.);
    set(
        &editor,
        cx,
        "links",
        vec![
            Decoration::new(
                "e1",
                0..2,
                Look::Underline(Underline::sand(ul, blue, Strength::new(0.7, 0.95))),
            )
            .touch(Touch::HOVER),
            Decoration::new(
                "s1",
                3..6,
                Look::Underline(Underline::dotted(blue, Strength::new(0.5, 0.8))),
            ),
        ],
    );
    set(
        &editor,
        cx,
        "agent",
        vec![
            Decoration::new("a1", 6..10, Look::Ink(hsla(0.41, 0.42, 0.34, 1.))).touch(Touch::Fade),
        ],
    );
    advance(cx, motion::FADE);
    let link = painted(&editor, cx, "links", "e1").unwrap();
    assert_eq!(link.boxes.len(), 1);
    assert!((link.alpha - 0.7).abs() < 1e-4);
    assert_eq!(painted(&editor, cx, "agent", "a1").unwrap().alpha, 1.);
    // Hovering the link deepens it at once (rest 0), eased.
    cx.simulate_mouse_move(center(link.boxes[0]), None, Modifiers::default());
    advance(cx, motion::SHIFT);
    let hot = painted(&editor, cx, "links", "e1").unwrap().alpha;
    assert!((hot - 0.95).abs() < 1e-4, "{hot}");
}

// ----- the pointer -------------------------------------------------------------------

#[gpui::test]
fn touching_an_agent_change_lets_it_go(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[(BlockKind::Body, "甲乙丙丁戊己庚辛")]);
    let seen = events(&editor, cx);
    let green = hsla(0.41, 0.42, 0.34, 1.);
    let change = Decoration::new("a1", 2..6, Look::Ink(green)).touch(Touch::Fade);
    set(&editor, cx, "agent", vec![change.clone()]);
    advance(cx, motion::FADE);
    let at = painted(&editor, cx, "agent", "a1").unwrap().boxes[0];
    // A quick flick across it from above counts, though no event lands on it.
    let above = at.center() - point(px(0.), px(200.));
    let below = at.center() + point(px(0.), px(200.));
    cx.simulate_mouse_move(above, None, Modifiers::default());
    cx.simulate_mouse_move(below, None, Modifiers::default());
    draw(cx);
    assert!(seen.borrow().contains(&DecorationEvent::Touched {
        chapter: 0,
        key: key("agent", "a1"),
    }));
    advance(cx, motion::TOUCH_FADE / 2);
    let fading = painted(&editor, cx, "agent", "a1").unwrap().alpha;
    assert!(fading > 0. && fading < 1., "{fading}");
    advance(cx, motion::TOUCH_FADE);
    assert!(painted(&editor, cx, "agent", "a1").is_none());
    // The host has not caught up yet and submits it again: it stays gone.
    set(&editor, cx, "agent", vec![change]);
    advance(cx, motion::FADE);
    assert!(painted(&editor, cx, "agent", "a1").is_none());
}

#[gpui::test]
fn the_prose_scrolling_under_a_still_pointer_touches(cx: &mut TestAppContext) {
    let mut paragraphs: Vec<(BlockKind, &str)> = vec![(BlockKind::Body, LONG); 30];
    paragraphs[12] = (BlockKind::Body, "Agent刚写进这一段的字");
    let (editor, cx) = editor(cx, &paragraphs);
    let seen = events(&editor, cx);
    let start = editor.update(cx, |e, _| e.book.chapters[0].doc.line_start(12));
    set(
        &editor,
        cx,
        "agent",
        vec![
            Decoration::new("a1", start..start + 12, Look::Ink(hsla(0.7, 0.4, 0.5, 1.)))
                .touch(Touch::Fade),
        ],
    );
    advance(cx, motion::FADE);
    // The pointer rests near the top of the view, over where the changed
    // words' column is; the paragraph is far below.
    let left = editor.update(cx, |e, _| e.frame.borrow().lines[0].origin.x);
    cx.simulate_mouse_move(point(left + px(100.), px(120.)), None, Modifiers::default());
    draw(cx);
    assert!(seen.borrow().is_empty());
    // Scroll in small steps so the words pass under the pointer.
    for _ in 0..80 {
        editor.update(cx, |e, cx| {
            e.scroll_by_estimate(24., cx);
        });
        draw(cx);
        if !seen.borrow().is_empty() {
            break;
        }
    }
    assert!(seen.borrow().contains(&DecorationEvent::Touched {
        chapter: 0,
        key: key("agent", "a1"),
    }));
}

#[gpui::test]
fn resting_on_a_comment_points_at_it(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[
            (BlockKind::Body, "甲乙丙丁戊己庚辛"),
            (BlockKind::Body, "另一段"),
        ],
    );
    let seen = events(&editor, cx);
    set(
        &editor,
        cx,
        "comments",
        vec![comment("c1", 2..5).touch(Touch::POINT)],
    );
    advance(cx, motion::FADE);
    let at = painted(&editor, cx, "comments", "c1").unwrap().boxes[0];
    cx.simulate_mouse_move(at.center(), None, Modifiers::default());
    draw(cx);
    assert!(
        seen.borrow().is_empty(),
        "not before the pointer has rested"
    );
    advance(cx, motion::POINT_REST);
    assert_eq!(
        seen.borrow().last(),
        Some(&DecorationEvent::Pointed {
            ids: vec![(0, key("comments", "c1"))]
        })
    );
    advance(cx, motion::SHIFT);
    let hot = painted(&editor, cx, "comments", "c1").unwrap().alpha;
    assert!((hot - 0.61).abs() < 1e-4, "{hot}");
    // Dragging a selection over it points at nothing; leaving lets go at once.
    cx.simulate_mouse_move(
        at.center() + point(px(0.), px(300.)),
        None,
        Modifiers::default(),
    );
    draw(cx);
    assert_eq!(
        seen.borrow().last(),
        Some(&DecorationEvent::Pointed { ids: vec![] })
    );
    cx.simulate_mouse_move(at.center(), MouseButton::Left, Modifiers::default());
    advance(cx, motion::POINT_REST * 2);
    assert_eq!(
        seen.borrow().last(),
        Some(&DecorationEvent::Pointed { ids: vec![] })
    );
}

// ----- block styles --------------------------------------------------------------------

fn styled(text: &'static str, attrs: &[(&'static str, LoroValue)]) -> ProseDoc {
    let mut doc = ProseDoc::from_paragraphs([(BlockKind::Body, "上一段"), (BlockKind::Body, text)]);
    for (key, value) in attrs {
        doc.set_block_attr(1, key, Some(value.clone()), crate::text::ORIGIN_USER);
    }
    doc.drain();
    doc
}

fn block_editor(
    cx: &mut TestAppContext,
    doc: ProseDoc,
) -> (Entity<ProseEditor>, &mut VisualTestContext) {
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc,
    }]);
    let (editor, cx) =
        cx.add_window_view(|window, cx| ProseEditor::new(book, ProseStyle::default(), window, cx));
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    (editor, cx)
}

fn origins(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    line: usize,
) -> Vec<Point<Pixels>> {
    editor.update(cx, |e, _| {
        e.frame
            .borrow()
            .lines
            .iter()
            .filter(|l| l.line == line)
            .map(|l| l.origin)
            .collect()
    })
}

#[gpui::test]
fn indents_and_quotes_move_the_text_in(cx: &mut TestAppContext) {
    let (editor, cx) = block_editor(cx, styled("缩进三格", &[(block::INDENT, 3i64.into())]));
    let plain = origins(&editor, cx, 0)[0];
    let indented = origins(&editor, cx, 1)[0];
    let body = f32::from(ProseStyle::default().body_size);
    assert!((f32::from(indented.x - plain.x) - body * 6.).abs() < 0.5);
    let look = editor.update(cx, |e, _| e.block_look(0, 1));
    assert_eq!(look.indent, 3);

    let (editor, cx) = block_editor(cx, styled("引文", &[(block::QUOTE, true.into())]));
    let plain = origins(&editor, cx, 0)[0];
    let quoted = origins(&editor, cx, 1)[0];
    assert!((f32::from(quoted.x - plain.x) - body).abs() < 0.5);
    // A click lands on the right character of the indented text.
    let at = quoted + point(px(body * 1.5), px(10.));
    cx.simulate_click(at, Modifiers::default());
    let head = editor.update(cx, |e, _| e.selection().head);
    let line_start = editor.update(cx, |e, _| e.book.chapters[0].doc.line_start(1));
    assert!(head == line_start + 1 || head == line_start + 2, "{head}");
}

/// The placed x of each row's first character in paragraph `line` (the
/// layout sets alignment since F4b; one record per paragraph).
fn row_starts(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    line: usize,
) -> Vec<Pixels> {
    editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let painted = frame.lines.iter().find(|l| l.line == line).unwrap();
        (0..painted.layout.row_count())
            .map(|row| painted.origin.x + painted.layout.x_at(row, painted.layout.rows[row].start))
            .collect()
    })
}

#[gpui::test]
fn alignment_moves_rows_and_clicks_follow(cx: &mut TestAppContext) {
    let (editor, cx) = block_editor(cx, styled("居中", &[(block::ALIGN, "center".into())]));
    let plain = row_starts(&editor, cx, 0)[0];
    let centered = row_starts(&editor, cx, 1);
    assert_eq!(origins(&editor, cx, 1).len(), 1, "one record per paragraph");
    assert!(centered[0] > plain + px(200.), "{centered:?}");
    assert_eq!(
        editor.update(cx, |e, _| e.block_look(0, 1).align),
        Align::Center
    );
    // Clicking just before the end of the first character puts the caret
    // after it: hit testing knows where the row moved to.
    let (origin, first_end) = editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let line = frame.lines.iter().find(|l| l.line == 1).unwrap();
        (line.origin, line.layout.x_at(0, "居".len()))
    });
    cx.simulate_click(
        origin + point(first_end - px(2.), px(10.)),
        Modifiers::default(),
    );
    let line_start = editor.update(cx, |e, _| e.book.chapters[0].doc.line_start(1));
    assert_eq!(editor.update(cx, |e, _| e.selection().head), line_start + 1);

    // A long right-aligned paragraph: its last row moves, the full rows
    // barely.
    let long: &'static str = LONG;
    let (editor, cx) = block_editor(cx, styled(long, &[(block::ALIGN, "right".into())]));
    let rows = row_starts(&editor, cx, 1);
    assert!(rows.len() >= 2, "{rows:?}");
    let last = *rows.last().unwrap();
    assert!(last > rows[0] + px(40.), "{rows:?}");
    // A click on the moved last row finds its first character.
    let (origin, top) = editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let line = frame.lines.iter().find(|l| l.line == 1).unwrap();
        let row = line.layout.row_count() - 1;
        (line.origin, line.line_height * row as f32)
    });
    cx.simulate_click(
        point(last + px(1.), origin.y + top + px(10.)),
        Modifiers::default(),
    );
    let (head, expected) = editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let line = frame.lines.iter().find(|l| l.line == 1).unwrap();
        let start_byte = line.layout.rows.last().unwrap().start;
        let doc = &e.book.chapters[0].doc;
        (
            e.selection().head,
            doc.line_start(1) + doc.line(1).char_of_byte(start_byte),
        )
    });
    assert_eq!(head, expected);
}

#[gpui::test]
fn a_rule_is_one_line_tall_and_headings_take_block_styles_too(cx: &mut TestAppContext) {
    let (editor, cx) = block_editor(cx, styled("", &[(block::RULE, true.into())]));
    assert!(editor.update(cx, |e, _| e.block_look(0, 1).rule));
    let mut doc =
        ProseDoc::from_paragraphs([(BlockKind::Body, "正文"), (BlockKind::H2, "二级标题")]);
    doc.set_block_attr(
        1,
        block::INDENT,
        Some(2i64.into()),
        crate::text::ORIGIN_USER,
    );
    doc.drain();
    let (editor, cx) = block_editor(cx, doc);
    let plain = origins(&editor, cx, 0)[0];
    let heading = origins(&editor, cx, 1)[0];
    let body = f32::from(ProseStyle::default().body_size);
    assert!((f32::from(heading.x - plain.x) - body * 4.).abs() < 0.5);
}

// ----- immersive writing -----------------------------------------------------------------

#[gpui::test]
fn immersive_writing_fades_all_but_the_caret_paragraph(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[
            (BlockKind::Body, "第一段"),
            (BlockKind::Body, "第二段"),
            (BlockKind::H1, "标题"),
        ],
    );
    let alpha = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize| {
        editor.update(cx, |e, cx| {
            let now = cx.background_executor().now();
            e.paint.focus.alpha((0, line), now)
        })
    };
    editor.update_in(cx, |e, window, cx| e.select(0, 1..1, window, cx));
    editor.update(cx, |e, cx| e.set_paragraph_focus(true, cx));
    draw(cx);
    advance(cx, motion::FOCUS_SHIFT / 2);
    let mid = alpha(&editor, cx, 1);
    assert!(mid < 1. && mid > FOCUS_DIM, "{mid}");
    advance(cx, motion::FOCUS_SHIFT);
    assert_eq!(alpha(&editor, cx, 0), 1.);
    assert!((alpha(&editor, cx, 1) - FOCUS_DIM).abs() < 1e-4);
    assert!((alpha(&editor, cx, 2) - FOCUS_DIM).abs() < 1e-4);
    // The caret moves to the heading: it comes up, the first paragraph goes down.
    let start = editor.update(cx, |e, _| e.book.chapters[0].doc.line_start(2));
    editor.update_in(cx, |e, window, cx| e.select(0, start..start, window, cx));
    draw(cx);
    advance(cx, motion::FOCUS_SHIFT / 2);
    let rising = alpha(&editor, cx, 2);
    let falling = alpha(&editor, cx, 0);
    assert!(rising > FOCUS_DIM && rising < 1., "{rising}");
    assert!(falling > FOCUS_DIM && falling < 1., "{falling}");
    advance(cx, motion::FOCUS_SHIFT);
    assert_eq!(alpha(&editor, cx, 2), 1.);
    // Off again: everything comes back.
    editor.update(cx, |e, cx| e.set_paragraph_focus(false, cx));
    advance(cx, motion::FOCUS_SHIFT);
    assert_eq!(alpha(&editor, cx, 1), 1.);
}

// ----- scrollbar ticks ----------------------------------------------------------------------

#[gpui::test]
fn ticks_sit_at_their_paragraphs_and_a_click_scrolls_there(cx: &mut TestAppContext) {
    let paragraphs: Vec<(BlockKind, &str)> = vec![(BlockKind::Body, LONG); 60];
    let (editor, cx) = editor(cx, &paragraphs);
    let seen = events(&editor, cx);
    let red = hsla(0., 0.6, 0.5, 1.);
    let marks: Vec<Decoration> = [5usize, 30, 55]
        .iter()
        .map(|&line| {
            let start = editor.update(cx, |e, _| e.book.chapters[0].doc.line_start(line));
            comment(&format!("c{line}"), start..start + 4).tick(Tick {
                color: red,
                lane: TickLane::Span,
            })
        })
        .collect();
    set(&editor, cx, "comments", marks);
    advance(cx, motion::FADE);
    let spots: Vec<f64> = editor.update(cx, |e, _| e.tick_fractions());
    assert_eq!(spots.len(), 3);
    assert!(spots[0] < spots[1] && spots[1] < spots[2], "{spots:?}");
    // Click the last tick: the editor scrolls there and tells the host.
    let window = cx.update(|window, _| window.viewport_size());
    let y = px(spots[2] as f32 * f32::from(window.height));
    cx.simulate_click(point(window.width - px(6.), y), Modifiers::default());
    draw(cx);
    assert!(seen.borrow().contains(&DecorationEvent::TickClicked {
        chapter: 0,
        key: key("comments", "c55"),
    }));
    let top = editor.update(cx, |e, _| e.list_state().logical_scroll_top().item_ix);
    assert!(top > 40, "scrolled near paragraph 55: {top}");
}

// ----- find ---------------------------------------------------------------------------

#[gpui::test]
fn find_matches_are_drawn_with_the_current_one_stronger(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[
            (BlockKind::Body, "灯芯往下拨了拨"),
            (BlockKind::Body, "岸上的灯一盏一盏地灭"),
        ],
    );
    editor.update_in(cx, |e, window, cx| {
        e.set_find_look(
            Some(Wash::flat(
                hsla(0.58, 0.9, 0.5, 1.),
                Strength::new(0.16, 0.34),
            )),
            cx,
        );
        e.set_find("灯", crate::input::find::FindOptions::default(), window, cx);
    });
    draw(cx);
    let first = painted(&editor, cx, "find", "0").unwrap();
    let second = painted(&editor, cx, "find", "1").unwrap();
    assert_eq!(first.boxes.len(), 1);
    // The first match is current (find selects it): stronger.
    assert!((first.alpha - 0.34).abs() < 1e-4, "{}", first.alpha);
    assert!((second.alpha - 0.16).abs() < 1e-4, "{}", second.alpha);
    editor.update_in(cx, |e, window, cx| {
        e.find_next(window, cx);
    });
    draw(cx);
    assert!((painted(&editor, cx, "find", "1").unwrap().alpha - 0.34).abs() < 1e-4);
    // No query, nothing drawn.
    editor.update(cx, |e, cx| e.clear_find(cx));
    draw(cx);
    assert!(painted(&editor, cx, "find", "0").is_none());
}

// ----- lists ---------------------------------------------------------------------------

/// A host that knows one TODO is done.
struct Todos;

impl crate::ProseExtension for Todos {
    fn task_done(&self, todo: &str) -> Option<bool> {
        (todo == "t-done").then_some(true)
    }
}

fn list_editor(cx: &mut TestAppContext) -> (Entity<ProseEditor>, &mut VisualTestContext) {
    let mut doc = ProseDoc::from_paragraphs([
        (BlockKind::Body, "正文"),
        (BlockKind::Body, "一"),
        (BlockKind::Body, "二"),
        (BlockKind::Body, "二下面的一条"),
        (BlockKind::Body, "三"),
        (BlockKind::Body, "隔开"),
        (BlockKind::Body, "又从一数"),
        (BlockKind::Body, "买灯芯"),
        (BlockKind::Body, "问钟楼的年代"),
    ]);
    let set = |doc: &mut ProseDoc, line: usize, key: &str, value: LoroValue| {
        doc.set_block_attr(line, key, Some(value), crate::text::ORIGIN_USER)
    };
    for line in [1, 2, 4, 6] {
        set(&mut doc, line, block::LIST, "ordered".into());
    }
    set(&mut doc, 3, block::LIST, "bullet".into());
    set(&mut doc, 3, block::LIST_LEVEL, 1i64.into());
    set(&mut doc, 7, block::LIST, "task".into());
    set(&mut doc, 7, block::CHECKED, true.into());
    set(&mut doc, 8, block::LIST, "task".into());
    set(&mut doc, 8, block::TODO, "t-done".into());
    doc.drain();
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc,
    }]);
    let (editor, cx) = cx.add_window_view(|window, cx| {
        let mut e = ProseEditor::new(book, ProseStyle::default(), window, cx);
        e.set_extension(Rc::new(Todos));
        e
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    (editor, cx)
}

#[gpui::test]
fn list_items_are_numbered_set_in_and_tasks_tick(cx: &mut TestAppContext) {
    use super::blocks::ListMark;
    let (editor, cx) = list_editor(cx);
    let mark = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize| {
        editor.update(cx, |e, _| e.block_look(0, line).list.map(|l| l.mark))
    };
    // Counted along the items of their level; a deeper item does not break
    // the count, a plain paragraph does.
    assert_eq!(mark(&editor, cx, 1), Some(ListMark::Ordered(1)));
    assert_eq!(mark(&editor, cx, 2), Some(ListMark::Ordered(2)));
    assert_eq!(mark(&editor, cx, 3), Some(ListMark::Bullet));
    assert_eq!(mark(&editor, cx, 4), Some(ListMark::Ordered(3)));
    assert_eq!(mark(&editor, cx, 6), Some(ListMark::Ordered(1)));
    // A task's own `checked`, and a linked TODO's state from the host.
    assert_eq!(mark(&editor, cx, 7), Some(ListMark::Task { done: true }));
    assert_eq!(mark(&editor, cx, 8), Some(ListMark::Task { done: true }));
    // The text moves right by a level, the nested item by two.
    let body = f32::from(ProseStyle::default().body_size);
    let plain = origins(&editor, cx, 0)[0];
    let item = origins(&editor, cx, 1)[0];
    let nested = origins(&editor, cx, 3)[0];
    assert!((f32::from(item.x - plain.x) - body * 1.5).abs() < 0.5);
    assert!((f32::from(nested.x - plain.x) - body * 3.).abs() < 0.5);
    // A click on the task's box asks the host to tick it; the caret stays.
    let seen = events(&editor, cx);
    let caret = editor.update(cx, |e, _| e.selection().head);
    let task = origins(&editor, cx, 7)[0];
    let lh = f32::from(ProseStyle::default().body_size) * 0.9;
    cx.simulate_click(task + point(px(-body * 0.9), px(lh)), Modifiers::default());
    draw(cx);
    assert!(
        seen.borrow().contains(&DecorationEvent::TaskClicked {
            chapter: 0,
            line: 7
        }),
        "{:?}",
        seen.borrow()
    );
    assert_eq!(editor.update(cx, |e, _| e.selection().head), caret);
}

#[gpui::test]
fn lists_code_and_callouts_take_their_own_gaps(cx: &mut TestAppContext) {
    let mut doc = ProseDoc::from_paragraphs([
        (BlockKind::Body, "正文"),
        (BlockKind::Body, "一"),
        (BlockKind::Body, "二"),
        (BlockKind::Body, "列表之后"),
        (BlockKind::Body, "let a = 1;"),
        (BlockKind::Body, "let b = 2;"),
        (BlockKind::Body, "代码之后"),
        (BlockKind::Body, "提示一"),
        (BlockKind::Body, "提示二"),
        (BlockKind::Body, "末尾"),
    ]);
    let set = |doc: &mut ProseDoc, line: usize, key: &str, value: LoroValue| {
        doc.set_block_attr(line, key, Some(value), crate::text::ORIGIN_USER)
    };
    set(&mut doc, 1, block::LIST, "bullet".into());
    set(&mut doc, 2, block::LIST, "bullet".into());
    set(&mut doc, 4, block::CODE_BLOCK, "rust".into());
    set(&mut doc, 5, block::CODE_BLOCK, "rust".into());
    set(&mut doc, 7, block::CALLOUT, "note".into());
    set(&mut doc, 8, block::CALLOUT, "note".into());
    doc.drain();
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc,
    }]);
    let style = ProseStyle {
        first_line_indent: 2.,
        justify: true,
        ..ProseStyle::default()
    };
    let (editor, cx) = cx.add_window_view(|window, cx| ProseEditor::new(book, style, window, cx));
    cx.simulate_resize(size(px(900.), px(900.)));
    draw(cx);

    let blocks = super::blocks::BlockStyle::default();
    let body = f32::from(ProseStyle::default().body_size);
    let em = |ems: f32| (body * ems).round();
    let spacing = em(ProseStyle::default().paragraph_spacing);
    let m = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, line: usize| {
        editor.update(cx, |e, _| e.para_metrics(0, line))
    };
    // Adjacent items sit 0.15 em apart; the last takes the paragraph
    // spacing.
    assert_eq!(m(&editor, cx, 1).pad_bottom, em(blocks.list_gap));
    assert_eq!(m(&editor, cx, 2).pad_bottom, spacing);
    let (one, two) = (origins(&editor, cx, 1)[0], origins(&editor, cx, 2)[0]);
    let lh = m(&editor, cx, 1).line_height;
    assert_eq!(f32::from(two.y - one.y), lh + em(blocks.list_gap));
    // A code block: a smaller face on tighter rows, padded at its ends and
    // touching inside, set in by its padding, in the monospace face.
    let (first, last) = (m(&editor, cx, 4), m(&editor, cx, 5));
    assert!((first.font_size - body * blocks.code_size).abs() < 0.01);
    assert_eq!(
        first.line_height,
        (body * blocks.code_size * blocks.code_line_height).round()
    );
    assert_eq!((first.pad_top, first.pad_bottom), (em(blocks.code_pad), 0.));
    assert_eq!(
        (last.pad_top, last.pad_bottom),
        (0., em(blocks.code_pad) + spacing)
    );
    let plain = origins(&editor, cx, 3)[0];
    let code = origins(&editor, cx, 4)[0];
    assert!((f32::from(code.x - plain.x) - body * blocks.code_inset).abs() < 0.5);
    let family = editor.update(cx, |e, _| e.display(0, 4).runs[0].font.family.clone());
    assert_eq!(family, ProseStyle::default().mono_family);
    // Only plain body paragraphs take the first-line indent; code is never
    // justified.
    editor.update(cx, |e, _| {
        assert_eq!(e.para_set(0, 0).setting.first_indent, px(body * 2.));
        assert_eq!(e.para_set(0, 1).setting.first_indent, px(0.));
        let code = e.para_set(0, 4).setting;
        assert_eq!(code.first_indent, px(0.));
        assert!(!code.justify && !code.squeeze);
    });
    // A callout: padded at its ends, its paragraphs 0.4 em apart, set in on
    // both sides.
    let (first, last) = (m(&editor, cx, 7), m(&editor, cx, 8));
    assert_eq!(
        (first.pad_top, first.pad_bottom),
        (em(blocks.callout_pad), em(blocks.callout_gap))
    );
    assert_eq!(
        (last.pad_top, last.pad_bottom),
        (0., em(blocks.callout_pad) + spacing)
    );
    let aside = origins(&editor, cx, 7)[0];
    assert!((f32::from(aside.x - plain.x) - body * blocks.callout_inset).abs() < 0.5);
    let (wrap_plain, wrap_aside) = editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let wrap = |line: usize| {
            frame
                .lines
                .iter()
                .find(|l| l.line == line)
                .map(|l| f32::from(l.layout.wrap_width))
                .unwrap()
        };
        (wrap(3), wrap(7))
    });
    assert!((wrap_plain - wrap_aside - 2. * body * blocks.callout_inset).abs() < 0.5);
    // The estimates know all of it: every one-row paragraph's estimate is
    // its measured height.
    editor.update(cx, |e, _| {
        let heights = e.heights.borrow();
        let column = (0..10)
            .map(|line| {
                let frame = e.frame.borrow();
                let l = frame.lines.iter().find(|l| l.line == line).unwrap();
                f32::from(l.layout.wrap_width) + f32::from(e.para_set(0, line).narrowing())
            })
            .next()
            .unwrap();
        for line in 0..10 {
            // Item 0 is the chapter's title.
            assert!(heights.is_measured(line + 1), "line {line}");
            let estimate = e.estimate_set(0, line, column);
            assert_eq!(estimate, heights.height(line + 1), "line {line}");
        }
    });
}
