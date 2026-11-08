//! Input as GPUI v1.27's Windows backend sends it (`gpui_windows`,
//! `handle_ime_composition_inner` and `WM_CHAR`), and the input method told
//! to drop its marked text: when the editor loses focus inside the window,
//! when the window loses the keyboard, and when input arrives after that.
//! What only a real Windows input method can show is in the manual tests of
//! `docs/rust-rewrite/foundations/f4c-input.md`.

use std::{cell::Cell, rc::Rc};

use gpui::{Entity, TestAppContext, VisualTestContext};

use super::*;
use crate::{PlatformHooks, layout::BookPos};

/// `WM_IME_COMPOSITION` with `GCS_COMPSTR`: the composition, the cursor in
/// it (UTF-16) when the input method sent `GCS_CURSORPOS`.
fn compstr(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    text: &str,
    cursor: Option<usize>,
) {
    editor.update_in(cx, |e, window, cx| {
        e.replace_and_mark_text_in_range(None, text, cursor.map(|c| c..c), window, cx)
    });
}

/// `WM_IME_COMPOSITION` with `GCS_RESULTSTR`, and `WM_CHAR`.
fn resultstr(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, text: &str) {
    commit(editor, cx, text);
}

/// `WM_IME_COMPOSITION` with no flags: the composition cleared.
fn cleared(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) {
    commit(editor, cx, "");
}

fn marked_range(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Option<Range<usize>> {
    editor.update_in(cx, |e, window, cx| e.marked_text_range(window, cx))
}

fn composing(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> bool {
    editor.update(cx, |e, _| e.composition().is_some())
}

/// Counts the editor's `Edited` events.
fn edits(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Rc<Cell<usize>> {
    let count: Rc<Cell<usize>> = Rc::default();
    cx.update(|_, cx| {
        let count = count.clone();
        cx.subscribe(editor, move |_, event: &EditorEvent, _| {
            if matches!(event, EditorEvent::Edited { .. }) {
                count.set(count.get() + 1);
            }
        })
        .detach();
    });
    count
}

#[gpui::test]
fn the_messages_of_a_windows_input_method(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜")]]);
    select(&editor, cx, 0, 2);
    // Microsoft Pinyin: each letter is a new composition string.
    compstr(&editor, cx, "n", Some(1));
    compstr(&editor, cx, "ni", Some(2));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n");
    assert_eq!(marked_range(&editor, cx), Some(2..4));
    // A phrase confirmed and the next one begun, in one message: the
    // result first, then the new composition after it.
    resultstr(&editor, cx, "你");
    compstr(&editor, cx, "h", Some(1));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜你\n");
    assert_eq!(marked_range(&editor, cx), Some(3..4));
    // Backspacing the last letter: an empty composition string cancels.
    compstr(&editor, cx, "", None);
    assert!(!composing(&editor, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜你\n");
    assert_eq!(head(&editor, cx), 3);
    // The Japanese IME puts its cursor inside the composition.
    compstr(&editor, cx, "かんじ", Some(1));
    let selected = editor.update_in(cx, |e, window, cx| e.selected_text_range(false, window, cx));
    assert_eq!(selected.map(|s| s.range), Some(4..4));
    resultstr(&editor, cx, "漢字");
    assert_eq!(loro_text(&editor, cx, 0), "雨夜你漢字\n");
    // Plain keys come as `WM_CHAR`, one character each.
    for c in ["。", "风"] {
        resultstr(&editor, cx, c);
    }
    assert_eq!(loro_text(&editor, cx, 0), "雨夜你漢字。风\n");
}

#[gpui::test]
fn a_cleared_composition_leaves_the_selection_it_was_to_replace(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜无声")]]);
    let edited = edits(&editor, cx);
    editor.update_in(cx, |e, window, cx| e.select(0, 0..2, window, cx));
    compstr(&editor, cx, "f", Some(1));
    // Esc in the Japanese IME (or the answer to a `CPS_CANCEL`): the
    // composition goes, the selected text stays.
    cleared(&editor, cx);
    assert!(!composing(&editor, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜无声\n");
    assert_eq!(head(&editor, cx), 0);
    assert_eq!(edited.get(), 0, "nothing was written");
    let steps = editor.update(cx, |e, _| e.book().chapters[0].doc.undo_count());
    assert_eq!(steps, 0);
}

#[gpui::test]
fn an_empty_insert_without_marked_text_changes_nothing(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[(BlockKind::Body, "甲乙")], &[(BlockKind::Body, "丙丁")]],
    );
    let edited = edits(&editor, cx);
    editor.update_in(cx, |e, window, cx| e.select(0, 0..2, window, cx));
    cleared(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "甲乙\n");
    assert_eq!(editor.update(cx, |e, _| e.selection().range()), 0..2);
    // Nor across chapters.
    editor.update_in(cx, |e, window, cx| {
        e.select_across(
            BookPos {
                chapter: 0,
                offset: 1,
            },
            BookPos {
                chapter: 1,
                offset: 1,
            },
            window,
            cx,
        )
    });
    cleared(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "甲乙\n");
    assert_eq!(loro_text(&editor, cx, 1), "丙丁\n");
    assert_eq!(edited.get(), 0);
    // A range the input method names is another matter (macOS replaces
    // a range by name): that still deletes.
    editor.update_in(cx, |e, window, cx| {
        e.select(0, 2..2, window, cx);
        e.replace_text_in_range(Some(0..1), "", window, cx);
    });
    assert_eq!(loro_text(&editor, cx, 0), "乙\n");
}

/// A system input method whose window can lose the keyboard.
#[derive(Default)]
struct FakeIme {
    away: Cell<bool>,
    discarded: Cell<usize>,
}

impl PlatformHooks for FakeIme {
    fn discard_marked_text(&self) {
        self.discarded.set(self.discarded.get() + 1);
    }

    fn has_keyboard(&self) -> bool {
        !self.away.get()
    }
}

fn fake_ime(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Rc<FakeIme> {
    let ime = Rc::new(FakeIme::default());
    editor.update(cx, |e, _| e.set_platform_hooks(ime.clone()));
    ime
}

#[gpui::test]
fn input_after_the_window_lost_the_keyboard_is_dropped(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜")]]);
    let ime = fake_ime(&editor, cx);
    select(&editor, cx, 0, 2);
    compstr(&editor, cx, "ni hao", Some(6));
    // The author switches to another application; the input method commits
    // its composition as focus leaves, before GPUI tells the editor.
    ime.away.set(true);
    resultstr(&editor, cx, "ni hao");
    assert_eq!(
        loro_text(&editor, cx, 0),
        "雨夜\n",
        "half-typed pinyin written"
    );
    assert!(!composing(&editor, cx));
    assert_eq!(ime.discarded.get(), 1, "the input method was not told");
    // Nothing else gets in while away, and there is nothing more to drop.
    resultstr(&editor, cx, "x");
    compstr(&editor, cx, "a", Some(1));
    editor.update_in(cx, |e, window, cx| e.unmark_text(window, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n");
    assert!(!composing(&editor, cx));
    assert_eq!(ime.discarded.get(), 1);
    // Back: typing works again.
    ime.away.set(false);
    compstr(&editor, cx, "hao", Some(3));
    resultstr(&editor, cx, "好");
    assert_eq!(loro_text(&editor, cx, 0), "雨夜好\n");
}

/// Focuses the editor in an active window and draws, so that focus events
/// flow.
fn focus_editor(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) {
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    editor.update_in(cx, |e, window, cx| window.focus(&e.focus, cx));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    editor.update_in(cx, |e, window, _| assert!(e.focus.is_focused(window)));
}

#[gpui::test]
fn losing_focus_or_the_window_tells_the_input_method(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜")]]);
    let ime = fake_ime(&editor, cx);
    let elsewhere = cx.update(|_, cx| cx.focus_handle());
    focus_editor(&editor, cx);
    select(&editor, cx, 0, 2);
    // Not composing: nothing to tell.
    cx.update(|window, cx| {
        window.focus(&elsewhere, cx);
        window.refresh();
    });
    cx.run_until_parked();
    assert_eq!(ime.discarded.get(), 0);
    // Focus moving inside the window (to the find bar, say).
    focus_editor(&editor, cx);
    compstr(&editor, cx, "ni", Some(2));
    cx.update(|window, cx| {
        window.focus(&elsewhere, cx);
        window.refresh();
    });
    cx.run_until_parked();
    assert!(!composing(&editor, cx));
    assert_eq!(ime.discarded.get(), 1);
    // The window losing the keyboard while the input method keeps its
    // composition: the blur that follows drops it.
    focus_editor(&editor, cx);
    compstr(&editor, cx, "hao", Some(3));
    cx.deactivate_window();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert!(!composing(&editor, cx));
    assert_eq!(ime.discarded.get(), 2);
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n");
}
