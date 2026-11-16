//! A pointer press while an input method is composing
//! (`docs/rust-rewrite/kernel-v5.md` §15, item 37): the marked text is
//! dropped, here and in the input method, nothing is written and no undo
//! step is made, and the caret goes where the press landed. A press inside
//! the marked text is the input method's. On macOS the input method may
//! commit as the press reaches it, before the editor's mouse-down: that
//! commit is dropped too. What only a real input method can show is in the
//! manual tests of `docs/rust-rewrite/foundations/f4c-input.md`.

use std::{cell::Cell, rc::Rc};

use gpui::{
    Bounds, Entity, Modifiers, MouseButton, Pixels, TestAppContext, VisualTestContext, Window,
};

use super::*;
use crate::PlatformHooks;

/// A system input method that counts being told to drop its marked text,
/// in an application that may be handling a pointer press.
#[derive(Default)]
struct FakeIme {
    discarded: Cell<usize>,
    pressing: Cell<bool>,
}

impl PlatformHooks for FakeIme {
    fn discard_marked_text(&self, _window: &Window) {
        self.discarded.set(self.discarded.get() + 1);
    }

    fn pointer_press_in_flight(&self) -> bool {
        self.pressing.get()
    }
}

fn fake_ime(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> Rc<FakeIme> {
    let ime = Rc::new(FakeIme::default());
    editor.update(cx, |e, _| e.set_platform_hooks(ime.clone()));
    ime
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

fn composing(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> bool {
    editor.update(cx, |e, _| e.composition().is_some())
}

fn press(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext, offset: usize) {
    editor.update_in(cx, |e, window, cx| {
        e.press_at(0, offset, 1, false, window, cx)
    });
}

#[gpui::test]
fn a_press_elsewhere_drops_the_marked_text_and_places_the_caret(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[(BlockKind::Body, "雨夜"), (BlockKind::Body, "天明了")]],
    );
    let ime = fake_ime(&editor, cx);
    let edited = edits(&editor, cx);
    select(&editor, cx, 0, 2);
    mark(&editor, cx, "zhong");
    assert!(composing(&editor, cx));
    // In the other paragraph, between 「明」 and 「了」.
    press(&editor, cx, 5);
    assert!(!composing(&editor, cx), "marked text left behind");
    assert_eq!(ime.discarded.get(), 1, "the input method was not told");
    assert_eq!(
        loro_text(&editor, cx, 0),
        "雨夜\n天明了\n",
        "pinyin written"
    );
    assert_eq!(edited.get(), 0);
    assert_eq!(head(&editor, cx), 5);
    // No undo step was made of it.
    undo(&editor, cx);
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n天明了\n");
    // Typing goes on from the new caret, as a fresh composition.
    mark(&editor, cx, "guo");
    commit(&editor, cx, "国");
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n天明国了\n");
    assert_eq!(ime.discarded.get(), 1);
}

#[gpui::test]
fn a_press_without_marked_text_tells_nobody(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜天明")]]);
    let ime = fake_ime(&editor, cx);
    select(&editor, cx, 0, 1);
    press(&editor, cx, 3);
    assert_eq!(head(&editor, cx), 3);
    assert_eq!(ime.discarded.get(), 0);
}

#[gpui::test]
fn a_selection_typed_over_is_still_there_after_the_press(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜天明")]]);
    let ime = fake_ime(&editor, cx);
    // Composing over 「夜天」: the committed text keeps it until confirmed.
    editor.update_in(cx, |e, window, cx| e.select(0, 1..3, window, cx));
    mark(&editor, cx, "ni");
    press(&editor, cx, 4);
    assert!(!composing(&editor, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜天明\n");
    assert_eq!(head(&editor, cx), 4);
    assert_eq!(ime.discarded.get(), 1);
}

/// macOS: GPUI hands the press to the input method before the editor's
/// mouse-down, and the input method answers by committing what was typed.
#[gpui::test]
fn what_an_input_method_commits_because_of_a_press_is_dropped(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "雨夜")]]);
    let ime = fake_ime(&editor, cx);
    let edited = edits(&editor, cx);
    select(&editor, cx, 0, 2);
    // `insertText:` with the pinyin as typed.
    mark(&editor, cx, "zhong");
    ime.pressing.set(true);
    commit(&editor, cx, "zhong");
    assert!(!composing(&editor, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n", "pinyin written");
    assert_eq!(ime.discarded.get(), 1);
    // `unmarkText`.
    ime.pressing.set(false);
    mark(&editor, cx, "guo");
    ime.pressing.set(true);
    editor.update_in(cx, |e, window, cx| e.unmark_text(window, cx));
    assert!(!composing(&editor, cx));
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n");
    assert_eq!(ime.discarded.get(), 2);
    assert_eq!(edited.get(), 0);
    // Only a composition is dropped: text that arrives during a press with
    // nothing marked is written as always.
    commit(&editor, cx, "x");
    assert_eq!(loro_text(&editor, cx, 0), "雨夜x\n");
    // And without a press the input method's commit is the author's.
    ime.pressing.set(false);
    mark(&editor, cx, "hao");
    commit(&editor, cx, "好");
    assert_eq!(loro_text(&editor, cx, 0), "雨夜x好\n");
    assert_eq!(ime.discarded.get(), 2);
}

/// Where the editor painted a range of the input method's view of the text.
fn painted(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    range16: Range<usize>,
) -> Bounds<Pixels> {
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    editor
        .update_in(cx, |e, window, cx| {
            e.bounds_for_range(range16, Bounds::default(), window, cx)
        })
        .expect("the range is painted")
}

/// Through the window: a real mouse-down on the painted text.
#[gpui::test]
fn the_mouse_drops_marked_text_elsewhere_and_leaves_it_when_pressed_on(cx: &mut TestAppContext) {
    let (editor, cx) = editor(
        cx,
        &[&[(BlockKind::Body, "雨夜"), (BlockKind::Body, "天明了")]],
    );
    let ime = fake_ime(&editor, cx);
    select(&editor, cx, 0, 2);
    mark(&editor, cx, "zhong");
    // On the marked text itself (its third letter; the input method's view
    // is 「雨夜zhong」 then the next paragraph): nothing happens here.
    let on_marked = painted(&editor, cx, 4..5).center();
    cx.simulate_mouse_down(on_marked, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(on_marked, MouseButton::Left, Modifiers::default());
    assert!(
        composing(&editor, cx),
        "a press on the marked text ended it"
    );
    assert_eq!(ime.discarded.get(), 0);
    assert_eq!(head(&editor, cx), 2);
    // On 「明」 in the next paragraph: the marked text goes, the caret lands
    // by 「明」, where the author pressed.
    let elsewhere = painted(&editor, cx, 9..10).center();
    cx.simulate_mouse_down(elsewhere, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(elsewhere, MouseButton::Left, Modifiers::default());
    assert!(!composing(&editor, cx), "marked text left behind");
    assert_eq!(ime.discarded.get(), 1);
    assert_eq!(loro_text(&editor, cx, 0), "雨夜\n天明了\n");
    let caret = head(&editor, cx);
    assert!(
        caret == 4 || caret == 5,
        "the caret is by 「明」, not at {caret}"
    );
}
