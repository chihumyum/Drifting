//! Selections across chapters (the whole-book view): extending with ⇧ and
//! the mouse, copying, and edits chapter by chapter with one undo.

use gpui::{Entity, TestAppContext, VisualTestContext};

use super::*;
use crate::layout::BookPos;

fn pos(chapter: usize, offset: usize) -> BookPos {
    BookPos { chapter, offset }
}

/// Three chapters, the middle one with two paragraphs.
fn three(cx: &mut TestAppContext) -> (Entity<ProseEditor>, &mut VisualTestContext) {
    editor(
        cx,
        &[
            &[(BlockKind::Body, "甲乙丙")],
            &[(BlockKind::Body, "丁戊"), (BlockKind::Body, "己")],
            &[(BlockKind::Body, "庚辛壬")],
        ],
    )
}

fn texts(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Vec<String> {
    (0..3).map(|c| loro_text(editor, cx, c)).collect()
}

fn select_across(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    anchor: BookPos,
    head: BookPos,
) {
    editor.update_in(cx, |e, window, cx| {
        e.select_across(anchor, head, window, cx)
    });
}

const BEFORE: [&str; 3] = ["甲乙丙\n", "丁戊\n己\n", "庚辛壬\n"];

#[gpui::test]
fn shift_arrows_and_drags_cross_chapters(cx: &mut TestAppContext) {
    let (editor, cx) = keyed_editor(
        cx,
        KeyScheme::Mac,
        &[
            &[(BlockKind::Body, "甲乙丙")],
            &[(BlockKind::Body, "丁戊"), (BlockKind::Body, "己")],
            &[(BlockKind::Body, "庚辛壬")],
        ],
    );
    select(&editor, cx, 0, 2);
    // ⇧→ past the chapter's end: the chapter boundary is one step.
    cx.simulate_keystrokes("shift-right shift-right shift-right");
    let sel = editor.update(cx, |e, _| e.selection());
    assert!(sel.spans_chapters());
    assert_eq!((sel.start(), sel.end()), (pos(0, 2), pos(1, 1)));
    assert_eq!(editor.update(cx, |e, _| e.selected_text()), "丙\n丁");
    // ⇧↓ goes on into the next chapter.
    cx.simulate_keystrokes("shift-down shift-down");
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!(sel.head_pos().chapter, 2);
    assert_eq!(sel.anchor_pos(), pos(0, 2));
    // Back again with ⇧↑ and ⇧←: one chapter, then a caret.
    cx.simulate_keystrokes("shift-up shift-up");
    assert_eq!(editor.update(cx, |e, _| e.selection().chapter), 1);
    editor.update_in(cx, |e, window, cx| {
        e.select_across(pos(0, 2), pos(1, 0), window, cx)
    });
    cx.simulate_keystrokes("shift-left");
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!(sel, crate::input::Selection::new(0, 2, 3));
    // → without ⇧ collapses a selection across chapters to its far end.
    select_across(&editor, cx, pos(2, 1), pos(0, 1));
    cx.simulate_keystrokes("right");
    assert_eq!(
        editor.update(cx, |e, _| e.selection()),
        crate::input::Selection::caret(2, 1)
    );
    // ⌥⇧→ at a chapter's end finds the next chapter's first word.
    select(&editor, cx, 0, 3);
    cx.simulate_keystrokes("alt-shift-right");
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!(sel.anchor_pos(), pos(0, 3));
    assert_eq!(sel.head_pos().chapter, 1);
    assert!(sel.head > 0);

    // A drag from one chapter into others.
    editor.update(cx, |e, cx| {
        e.click_at(0, 1, 1, false, cx);
        e.drag_to_in(2, 2, cx);
        e.release();
    });
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!((sel.start(), sel.end()), (pos(0, 1), pos(2, 2)));
    assert_eq!(
        editor.update(cx, |e, _| e.selected_text()),
        "乙丙\n丁戊\n己\n庚辛"
    );
    // A shift-click in another chapter extends the same way.
    editor.update(cx, |e, cx| {
        e.click_at(1, 1, 1, false, cx);
        e.release();
        e.click_at(0, 0, 1, true, cx);
        e.release();
    });
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!((sel.anchor_pos(), sel.head_pos()), (pos(1, 1), pos(0, 0)));
    // A double-click drag keeps the first word whole across chapters.
    editor.update(cx, |e, cx| {
        e.click_at(1, 1, 2, false, cx);
        let word = e.selection().range();
        e.drag_to_in(0, 1, cx);
        let sel = e.selection();
        assert_eq!(sel.anchor_pos(), pos(1, word.end));
        assert_eq!(sel.head_pos().chapter, 0);
        e.release();
    });
}

#[gpui::test]
fn what_each_chapter_shows_selected(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    select_across(&editor, cx, pos(2, 1), pos(0, 1));
    editor.update(cx, |e, _| {
        // The first chapter from the start to its end and on into the next.
        assert_eq!(e.selected_in(0), Some((1..3, true)));
        assert_eq!(e.selected_in(1), Some((0..4, true)));
        assert_eq!(e.selected_in(2), Some((0..1, false)));
        // Elsewhere the caret's chapter alone is the editor's own business.
        assert_eq!(e.selection().range(), 1..1);
    });
    // The input method sees the selection's part in the caret's chapter.
    editor.update_in(cx, |e, window, cx| {
        let s = e.selected_text_range(false, window, cx).unwrap();
        assert_eq!((s.range, s.reversed), (1..3, true));
    });
}

#[gpui::test]
fn copying_and_deleting_across_chapters(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    select_across(&editor, cx, pos(0, 1), pos(2, 1));
    editor.update_in(cx, |e, window, cx| e.on_copy(&Copy, window, cx));
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()));
    assert_eq!(copied.as_deref(), Some("乙丙\n丁戊\n己\n庚"));

    // Backspace: each chapter loses its part, no chapter is merged.
    editor.update_in(cx, |e, window, cx| e.press_backspace(window, cx));
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "辛壬\n"]);
    assert_eq!(
        editor.update(cx, |e, _| e.selection()),
        crate::input::Selection::caret(0, 1)
    );
    assert_eq!(editor.update(cx, |e, _| e.book().chapters.len()), 3);
    // One ⌘Z (in the caret's chapter) brings all of it back, one ⇧⌘Z takes it away again.
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);
    editor.update_in(cx, |e, window, cx| e.redo(window, cx));
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "辛壬\n"]);
    // The whole-book view's undo, by the caret's chapter, does the same.
    editor.update_in(cx, |e, window, cx| assert!(e.undo_in(0, window, cx)));
    assert_eq!(texts(&editor, cx), BEFORE);
    editor.update_in(cx, |e, window, cx| assert!(e.redo_in(2, window, cx)));
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "辛壬\n"]);
    editor.update_in(cx, |e, window, cx| assert!(e.undo_in(1, window, cx)));
    assert_eq!(texts(&editor, cx), BEFORE);

    // Cut is copy, then the same deletion.
    select_across(&editor, cx, pos(1, 3), pos(2, 2));
    editor.update_in(cx, |e, window, cx| e.on_cut(&Cut, window, cx));
    let cut = cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()));
    assert_eq!(cut.as_deref(), Some("己\n庚辛"));
    assert_eq!(texts(&editor, cx), ["甲乙丙\n", "丁戊\n\n", "壬\n"]);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);
}

#[gpui::test]
fn a_chapter_edited_since_keeps_its_part_for_its_own_undo(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    select_across(&editor, cx, pos(0, 1), pos(2, 1));
    editor.update_in(cx, |e, window, cx| e.press_backspace(window, cx));
    // The author then writes in the last chapter.
    select(&editor, cx, 2, 0);
    commit(&editor, cx, "又");
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "又辛壬\n"]);
    // ⌘Z in the first chapter: its part and the middle chapter's come back;
    // the last chapter's step is no longer its newest, so it stays.
    editor.update_in(cx, |e, window, cx| assert!(e.undo_in(0, window, cx)));
    assert_eq!(texts(&editor, cx), ["甲乙丙\n", "丁戊\n己\n", "又辛壬\n"]);
    // There, its own undo: first the typing, then its part of the deletion.
    editor.update_in(cx, |e, window, cx| assert!(e.undo_in(2, window, cx)));
    assert_eq!(loro_text(&editor, cx, 2), "辛壬\n");
    editor.update_in(cx, |e, window, cx| assert!(e.undo_in(2, window, cx)));
    assert_eq!(texts(&editor, cx), BEFORE);
}

#[gpui::test]
fn typing_pasting_and_enter_over_a_selection_across_chapters(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    // Typing: the text goes into the first chapter; one undo for all of it.
    select_across(&editor, cx, pos(0, 1), pos(2, 1));
    commit(&editor, cx, "新");
    assert_eq!(texts(&editor, cx), ["甲新\n", "\n", "辛壬\n"]);
    assert_eq!(
        editor.update(cx, |e, _| e.selection()),
        crate::input::Selection::caret(0, 2)
    );
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);

    // Pasting: the same, paragraphs and all.
    select_across(&editor, cx, pos(2, 1), pos(0, 1));
    editor.update_in(cx, |e, window, cx| e.paste_text("贴\n上", window, cx));
    assert_eq!(texts(&editor, cx), ["甲贴\n上\n", "\n", "辛壬\n"]);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);

    // Enter: the deletion is a step of its own, as for a selection across
    // paragraphs.
    select_across(&editor, cx, pos(0, 1), pos(2, 1));
    editor.update_in(cx, |e, window, cx| e.press_enter(window, cx));
    assert_eq!(texts(&editor, cx), ["甲\n\n", "\n", "辛壬\n"]);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "辛壬\n"]);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);

    // An input method composing over it: the deletion first, then the
    // marked text in the first chapter.
    select_across(&editor, cx, pos(0, 1), pos(2, 1));
    mark(&editor, cx, "xin");
    assert_eq!(texts(&editor, cx), ["甲\n", "\n", "辛壬\n"]);
    commit(&editor, cx, "心");
    assert_eq!(loro_text(&editor, cx, 0), "甲心\n");
    undo(&editor, cx);
    undo(&editor, cx);
    assert_eq!(texts(&editor, cx), BEFORE);
}

#[gpui::test]
fn formatting_a_selection_across_chapters(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    select_across(&editor, cx, pos(0, 1), pos(2, 2));
    editor.update_in(cx, |e, window, cx| {
        assert!(!e.mark_active(inline::BOLD));
        e.toggle_mark(inline::BOLD, window, cx);
        assert!(e.mark_active(inline::BOLD));
    });
    let bold = |editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, c: usize, at: usize| {
        editor.update(cx, |e, _| {
            e.book().chapters[c]
                .doc
                .marks_before(at + 1)
                .has(inline::BOLD)
        })
    };
    assert!(bold(&editor, cx, 0, 1) && !bold(&editor, cx, 0, 0));
    assert!(bold(&editor, cx, 1, 0) && bold(&editor, cx, 1, 3));
    assert!(bold(&editor, cx, 2, 1) && !bold(&editor, cx, 2, 2));
    // Toggled again: off everywhere; one undo each way.
    editor.update_in(cx, |e, window, cx| e.toggle_mark(inline::BOLD, window, cx));
    assert!(!bold(&editor, cx, 1, 0));
    undo(&editor, cx);
    assert!(bold(&editor, cx, 0, 1) && bold(&editor, cx, 2, 1));
    undo(&editor, cx);
    assert!(!bold(&editor, cx, 0, 1) && !bold(&editor, cx, 1, 0) && !bold(&editor, cx, 2, 1));
    // H1 on every paragraph it touches.
    select_across(&editor, cx, pos(0, 1), pos(2, 2));
    editor.update_in(cx, |e, window, cx| e.on_set_h1(&SetH1, window, cx));
    let kinds = editor.update(cx, |e, _| {
        (0..3)
            .flat_map(|c| {
                let doc = &e.book().chapters[c].doc;
                (0..doc.visible_lines())
                    .map(|l| doc.line(l).kind)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    });
    assert_eq!(kinds, [BlockKind::H1; 4]);
    undo(&editor, cx);
    assert_eq!(
        editor.update(cx, |e, _| e.book().chapters[1].doc.line(1).kind),
        BlockKind::Body
    );
}

#[gpui::test]
fn others_writes_move_both_ends(cx: &mut TestAppContext) {
    let (editor, cx) = three(cx);
    select_across(&editor, cx, pos(0, 2), pos(2, 1));
    // An Agent writes at the start of both chapters.
    editor.update(cx, |e, cx| {
        e.agent_write(0, 0..0, "一", "s", cx);
        e.agent_write(2, 0..0, "二二", "s", cx);
    });
    let sel = editor.update(cx, |e, _| e.selection());
    assert_eq!((sel.anchor_pos(), sel.head_pos()), (pos(0, 3), pos(2, 3)));
    assert_eq!(
        editor.update(cx, |e, _| e.selected_text()),
        "丙\n丁戊\n己\n二二庚"
    );
}
