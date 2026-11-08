//! How rows are set, in an editor on GPUI's test platform (real shaping):
//! first-line indent, justification, alignment as the input method and
//! vertical movement see it, typewriter scrolling and the estimates.

use gpui::{Entity, EntityInputHandler, Pixels, TestAppContext, VisualTestContext, px, size};

use crate::{
    ProseEditor, ProseStyle,
    input::actions::{MoveDown, MoveUp},
    layout::{Book, Chapter},
    schema::block,
    text::{BlockKind, ORIGIN_USER, ProseDoc},
};

const LONG: &str = "他把吸铁石拍在桌上，说这东西能把河里的铁钉都吸上来，谁也不信，可第二天一早，码头上围了一圈人，看他从水里一根一根地往外拽，拽到太阳落山，钉子堆得比他的膝盖还高。";

fn editor(
    cx: &mut TestAppContext,
    doc: ProseDoc,
    style: ProseStyle,
) -> (Entity<ProseEditor>, &mut VisualTestContext) {
    let book = Book::new(vec![Chapter {
        title: "第一章".into(),
        doc,
    }]);
    let (editor, cx) = cx.add_window_view(|window, cx| ProseEditor::new(book, style, window, cx));
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

/// Where paragraph `line`'s rows start, in window x.
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
fn body_paragraphs_take_the_first_line_indent(cx: &mut TestAppContext) {
    let doc = ProseDoc::from_paragraphs([
        (BlockKind::H2, "标题"),
        (BlockKind::Body, LONG),
        (BlockKind::Body, ""),
    ]);
    let style = ProseStyle {
        first_line_indent: 2.,
        ..ProseStyle::default()
    };
    let body = f32::from(style.body_size);
    let (editor, cx) = editor(cx, doc, style);
    let heading = row_starts(&editor, cx, 0)[0];
    let rows = row_starts(&editor, cx, 1);
    assert!(
        (f32::from(rows[0] - heading) - body * 2.).abs() < 0.5,
        "{rows:?}"
    );
    assert!(
        (f32::from(rows[1] - heading)).abs() < 0.5,
        "only the first row"
    );
    // The empty paragraph's caret sits at the indent too.
    editor.update_in(cx, |e, window, cx| {
        let at = e.book().chapters[0].doc.line_start(2);
        e.select(0, at..at, window, cx);
    });
    draw(cx);
    let caret = editor.update(cx, |e, _| e.cursor_rect.get().unwrap());
    assert!((f32::from(caret.left() - heading) - body * 2.).abs() < 0.5);
}

#[gpui::test]
fn justified_rows_end_at_the_column_edge(cx: &mut TestAppContext) {
    // Latin words make rows end short; justified, they reach the edge.
    let text = "Drifting 是一个写作软件，it keeps the whole book in one place，让人物、地点和情节都在手边。".repeat(3);
    let doc = ProseDoc::from_paragraphs([(BlockKind::Body, text.as_str())]);
    let ends = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext| {
        editor.update(cx, |e, _| {
            let frame = e.frame.borrow();
            let painted = &frame.lines[0];
            let layout = &painted.layout;
            (0..layout.row_count())
                .map(|row| {
                    // The row's content end, without trailing spaces.
                    let range = layout.rows[row].clone();
                    let trimmed = text[range.clone()].trim_end().len();
                    layout.x_at(row, range.start + trimmed)
                })
                .collect::<Vec<Pixels>>()
        })
    };
    let (plain, cx) = editor(cx, doc, ProseStyle::default());
    let plain_ends = ends(&plain, cx);
    let wrap = plain.update(cx, |e, _| e.frame.borrow().lines[0].layout.wrap_width);
    assert!(plain_ends.len() >= 3, "{plain_ends:?}");
    let doc = ProseDoc::from_paragraphs([(BlockKind::Body, text.as_str())]);
    let style = ProseStyle {
        justify: true,
        ..ProseStyle::default()
    };
    let (justified, cx) = editor(cx, doc, style);
    let justified_ends = ends(&justified, cx);
    let last = justified_ends.len() - 1;
    for (row, end) in justified_ends[..last].iter().enumerate() {
        // A hanging mark may reach past the edge; the content stops at it.
        assert!(
            (*end - wrap).abs() < px(0.6) || *end > wrap,
            "row {row}: {end:?} of {wrap:?}"
        );
    }
    assert!(
        plain_ends[..last].iter().any(|e| *e < wrap - px(2.)),
        "{plain_ends:?}"
    );
}

#[gpui::test]
fn the_candidate_window_and_vertical_moves_follow_aligned_rows(cx: &mut TestAppContext) {
    let mut doc = ProseDoc::from_paragraphs([(BlockKind::Body, "上一段"), (BlockKind::Body, LONG)]);
    doc.set_block_attr(1, block::ALIGN, Some("right".into()), ORIGIN_USER);
    doc.drain();
    let (editor, cx) = editor(cx, doc, ProseStyle::default());
    let rows = row_starts(&editor, cx, 1);
    assert!(
        rows.len() >= 2 && *rows.last().unwrap() > rows[0] + px(40.),
        "{rows:?}"
    );
    // The caret at the start of the last, moved row.
    let (start, last_row) = editor.update(cx, |e, _| {
        let frame = e.frame.borrow();
        let painted = frame.lines.iter().find(|l| l.line == 1).unwrap();
        let row = painted.layout.row_count() - 1;
        let byte = painted.layout.rows[row].start;
        let doc = &e.book.chapters[0].doc;
        (doc.line_start(1) + doc.line(1).char_of_byte(byte), row)
    });
    editor.update_in(cx, |e, window, cx| e.select(0, start..start, window, cx));
    draw(cx);
    // The input method asks where the caret is: the moved row's start.
    let bounds = editor.update_in(cx, |e, window, cx| {
        let at = e.book.chapters[0].doc.offset_to_utf16(start);
        e.bounds_for_range(at..at, Default::default(), window, cx)
            .unwrap()
    });
    assert!(
        (bounds.left() - *rows.last().unwrap()).abs() < px(0.6),
        "{bounds:?} {rows:?}"
    );
    // Up from there keeps the column: the row above is full, so the caret
    // lands near the same x, not at its start.
    let caret_x = editor.update(cx, |e, _| e.cursor_rect.get().unwrap().left());
    editor.update_in(cx, |e, window, cx| e.on_move_up(&MoveUp, window, cx));
    draw(cx);
    let above = editor.update(cx, |e, _| e.cursor_rect.get().unwrap());
    assert!(
        (above.left() - caret_x).abs() < px(20.),
        "{above:?} vs {caret_x:?}"
    );
    editor.update_in(cx, |e, window, cx| e.on_move_down(&MoveDown, window, cx));
    draw(cx);
    let back = editor.update(cx, |e, _| e.selection().head);
    assert_eq!(back, start, "down returns to the row start ({last_row})");
}

#[gpui::test]
fn typewriter_scrolling_keeps_the_caret_on_its_line(cx: &mut TestAppContext) {
    let paragraphs: Vec<(BlockKind, &str)> = (0..60).map(|_| (BlockKind::Body, LONG)).collect();
    let doc = ProseDoc::from_paragraphs(paragraphs);
    let style = ProseStyle {
        typewriter: Some(0.5),
        ..ProseStyle::default()
    };
    let (editor, cx) = editor(cx, doc, style);
    let view = editor.update(cx, |e, _| e.list_state().viewport_bounds());
    let line_of = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext| {
        editor.update(cx, |e, _| e.cursor_rect.get().map(|c| c.center().y))
    };
    for paragraph in [10usize, 30, 59] {
        editor.update_in(cx, |e, window, cx| {
            let at = e.book().chapters[0].doc.line_start(paragraph) + 3;
            e.select(0, at..at, window, cx);
            e.replace_text_in_range(None, "字", window, cx);
        });
        draw(cx);
        draw(cx);
        let debug = editor.update(cx, |e, _| {
            let frame = e.frame.borrow();
            (
                e.selection(),
                frame.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
                e.list_state().logical_scroll_top(),
            )
        });
        let y = line_of(&editor, cx).unwrap_or_else(|| panic!("the caret is painted: {debug:?}"));
        let target = view.top() + view.size.height * 0.5;
        assert!(
            (y - target).abs() < px(2.),
            "paragraph {paragraph}: caret at {y:?}, line at {target:?}"
        );
    }
    // Ordinary scrolling only keeps the caret in sight.
    editor.update(cx, |e, cx| {
        let mut style = e.style().clone();
        style.typewriter = None;
        e.set_style(style, cx);
    });
    editor.update_in(cx, |e, window, cx| {
        let at = e.book().chapters[0].doc.line_start(5);
        e.select(0, at..at, window, cx);
    });
    draw(cx);
    draw(cx);
    let y = line_of(&editor, cx).unwrap();
    assert!(y < view.top() + view.size.height * 0.4, "{y:?}");
}

#[gpui::test]
fn typewriter_scrolling_follows_its_line_and_waits_for_the_input_method(cx: &mut TestAppContext) {
    use gpui::Focusable;
    let paragraphs: Vec<(BlockKind, &str)> = (0..60).map(|_| (BlockKind::Body, LONG)).collect();
    let doc = ProseDoc::from_paragraphs(paragraphs);
    let style = ProseStyle {
        typewriter: Some(0.5),
        ..ProseStyle::default()
    };
    let (editor, cx) = editor(cx, doc, style);
    let focus = editor.update(cx, |e, cx| e.focus_handle(cx));
    cx.update(|window, cx| window.focus(&focus, cx));
    let caret_y = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext| {
        draw(cx);
        draw(cx);
        editor
            .update(cx, |e, _| e.cursor_rect.get().map(|c| c.center().y))
            .expect("the caret is painted")
    };
    let line = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, at: f32| {
        let view = editor.update(cx, |e, _| e.list_state().viewport_bounds());
        view.top() + view.size.height * at
    };
    let set_line = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, at: Option<f32>| {
        editor.update(cx, |e, cx| {
            let mut style = e.style().clone();
            style.typewriter = at;
            e.set_style(style, cx);
        });
    };
    editor.update_in(cx, |e, window, cx| {
        let at = e.book().chapters[0].doc.line_start(30) + 3;
        e.select(0, at..at, window, cx);
        e.replace_text_in_range(None, "字", window, cx);
    });
    let y = caret_y(&editor, cx);
    assert!((y - line(&editor, cx, 0.5)).abs() < px(2.), "{y:?}");
    // The line moves (the setting): the caret follows without a keystroke.
    set_line(&editor, cx, Some(0.3));
    let y = caret_y(&editor, cx);
    assert!((y - line(&editor, cx, 0.3)).abs() < px(2.), "{y:?}");
    // The window gets shorter: the caret stays on the line.
    cx.simulate_resize(size(px(900.), px(480.)));
    let y = caret_y(&editor, cx);
    assert!(
        (y - line(&editor, cx, 0.3)).abs() < px(2.),
        "after a resize: {y:?}"
    );
    // While the input method composes, nothing scrolls to the line (the
    // candidate window would move under the pinyin); the confirmed text
    // goes to it.
    set_line(&editor, cx, None);
    editor.update_in(cx, |e, window, cx| {
        let at = e.book().chapters[0].doc.line_start(45);
        e.select(0, at..at, window, cx);
    });
    let off = caret_y(&editor, cx);
    assert!((off - line(&editor, cx, 0.5)).abs() > px(40.), "{off:?}");
    editor.update_in(cx, |e, window, cx| {
        e.replace_and_mark_text_in_range(None, "zh", Some(2..2), window, cx)
    });
    set_line(&editor, cx, Some(0.5));
    let y = caret_y(&editor, cx);
    assert!(
        (y - line(&editor, cx, 0.5)).abs() > px(40.),
        "composing: {y:?}"
    );
    editor.update_in(cx, |e, window, cx| {
        e.replace_text_in_range(None, "中", window, cx)
    });
    let y = caret_y(&editor, cx);
    assert!(
        (y - line(&editor, cx, 0.5)).abs() < px(2.),
        "confirmed: {y:?}"
    );
}

#[gpui::test]
fn estimates_and_off_screen_layouts_take_the_block_inset_off(cx: &mut TestAppContext) {
    let mut doc = ProseDoc::from_paragraphs([(BlockKind::Body, LONG), (BlockKind::Body, LONG)]);
    doc.set_block_attr(1, block::INDENT, Some(8i64.into()), ORIGIN_USER);
    doc.drain();
    let (editor, cx) = editor(cx, doc, ProseStyle::default());
    let (plain, indented) = editor.update(cx, |e, _| {
        (e.estimate_set(0, 0, 680.), e.estimate_set(0, 1, 680.))
    });
    assert!(
        indented > plain,
        "an indented block wraps narrower: {plain} vs {indented}"
    );
    // The editor's own layout of a paragraph (as vertical movement uses
    // when it is not painted) wraps like the painted one.
    let (painted_rows, own_rows) = editor.update_in(cx, |e, window, _| {
        let painted = e.frame.borrow().get(0, 1).unwrap().layout.row_count();
        e.frame.borrow_mut().lines.clear();
        let (own, _) = e.line_layout(0, 1, window).unwrap();
        (painted, own.row_count())
    });
    assert_eq!(painted_rows, own_rows);
}

/// Rough cost of setting a paragraph (shaping is GPUI's and cached; this is
/// breaking and placing), printed:
/// `cargo test --release -p gpui-prose --lib setting_costs -- --ignored --nocapture`.
#[gpui::test]
#[ignore = "timing, run by hand in release"]
fn setting_costs(cx: &mut TestAppContext) {
    use crate::layout::{RowAlign, RowSetting, shape_set};
    use std::time::Instant;
    let text: String = LONG.repeat(25);
    let (editor, cx) = editor(
        cx,
        ProseDoc::from_paragraphs([(BlockKind::Body, "")]),
        ProseStyle::default(),
    );
    let _ = editor;
    let runs = vec![gpui::TextRun {
        len: text.len(),
        font: gpui::font("PingFang SC"),
        color: gpui::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    }];
    println!("paragraph: {} characters", text.chars().count());
    for (label, setting) in [
        ("plain", RowSetting::default()),
        (
            "indent + squeeze + justify",
            RowSetting {
                first_indent: px(35.),
                squeeze: true,
                justify: true,
                ..RowSetting::default()
            },
        ),
        (
            "centred",
            RowSetting {
                align: RowAlign::Center,
                ..RowSetting::default()
            },
        ),
    ] {
        cx.update(|window, _| {
            // Warm GPUI's shaping cache.
            shape_set(&text, px(17.5), &runs, px(680.), setting, window);
            let start = Instant::now();
            for _ in 0..50 {
                shape_set(&text, px(17.5), &runs, px(680.), setting, window);
            }
            println!(
                "{label}: {:.3} ms per layout",
                start.elapsed().as_secs_f64() * 1e3 / 50.
            );
        });
    }
}
