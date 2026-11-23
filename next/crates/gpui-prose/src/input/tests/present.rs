//! Drawing an edit at once ([`crate::EditorOptions::present_now`]): with the
//! option on, the platform is asked exactly once after every edit and every
//! composition update; with it off, never. The system's hook
//! (`input/system_ime.rs`) acts on macOS only, through the window's AppKit
//! view; a window without a native view (a test window, or any window on
//! Windows and Linux, where the hook is the trait's empty default) is left
//! alone.

use std::{cell::Cell, rc::Rc};

use gpui::{Entity, TestAppContext, VisualTestContext, Window};

use super::*;
use crate::{PlatformHooks, input::system_ime::SystemIme};

/// A platform that counts being asked to draw now.
#[derive(Default)]
struct CountingPlatform {
    presented: Cell<usize>,
}

impl PlatformHooks for CountingPlatform {
    fn discard_marked_text(&self, _window: &Window) {}

    fn present_now(&self, _window: &Window) {
        self.presented.set(self.presented.get() + 1);
    }
}

fn counting(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    present_now: bool,
) -> Rc<CountingPlatform> {
    let platform = Rc::new(CountingPlatform::default());
    editor.update(cx, |e, _| {
        e.options_mut().present_now = present_now;
        e.set_platform_hooks(platform.clone());
    });
    platform
}

/// What the author sees change: the stored text and the marked text.
fn state(editor: &Entity<ProseEditor>, cx: &mut VisualTestContext) -> (String, Option<String>) {
    let marked = editor.update(cx, |e, _| e.composition().map(|c| c.text.clone()));
    (loro_text(editor, cx, 0), marked)
}

type Step = (
    &'static str,
    fn(&Entity<ProseEditor>, &mut VisualTestContext),
);

/// Every kind of edit and composition update, in an order where each one
/// changes something.
const STEPS: &[Step] = &[
    ("typing a character", |e, cx| commit(e, cx, "雨")),
    ("Backspace", |e, cx| {
        e.update_in(cx, |e, window, cx| e.press_backspace(window, cx))
    }),
    ("Return", |e, cx| {
        e.update_in(cx, |e, window, cx| e.on_newline(&Newline, window, cx))
    }),
    ("a paste", |e, cx| {
        e.update_in(cx, |e, window, cx| e.paste_text("夜", window, cx))
    }),
    ("an undo", undo),
    ("a redo", |e, cx| {
        e.update_in(cx, |e, window, cx| e.redo(window, cx))
    }),
    ("the first marked text", |e, cx| mark(e, cx, "y")),
    ("the marked text growing", |e, cx| mark(e, cx, "yu")),
    ("the input method confirming", |e, cx| commit(e, cx, "雨")),
    ("marked text again", |e, cx| mark(e, cx, "zh")),
    ("all marked text deleted", |e, cx| mark(e, cx, "")),
    ("marked text once more", |e, cx| mark(e, cx, "abc")),
    ("the input method accepting it as it stands", |e, cx| {
        e.update_in(cx, |e, window, cx| e.unmark_text(window, cx))
    }),
];

/// Runs every step and checks that each changed what the author sees and
/// asked the platform to draw `per_step` times.
fn run_steps(
    editor: &Entity<ProseEditor>,
    cx: &mut VisualTestContext,
    platform: &CountingPlatform,
    per_step: usize,
) {
    select(editor, cx, 0, 2);
    for (name, step) in STEPS {
        let before = state(editor, cx);
        let presented = platform.presented.get();
        step(editor, cx);
        assert_ne!(state(editor, cx), before, "{name} changed nothing");
        assert_eq!(
            platform.presented.get() - presented,
            per_step,
            "{name}: asked to draw now"
        );
    }
}

#[gpui::test]
fn with_present_now_every_edit_and_composition_update_is_drawn_at_once(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    let platform = counting(&editor, cx, true);
    run_steps(&editor, cx, &platform, 1);
    // Moving the caret is not an edit.
    let presented = platform.presented.get();
    select(&editor, cx, 0, 0);
    assert_eq!(platform.presented.get(), presented);
}

#[gpui::test]
fn without_present_now_nothing_asks_to_draw(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    let platform = counting(&editor, cx, false);
    run_steps(&editor, cx, &platform, 0);
    assert_eq!(platform.presented.get(), 0);
}

/// The option on, no hooks from the host: the editor looks for the system's
/// at the first edit (here a Backspace, before any text input); a test
/// window has no native handle, so there are none and the edit just happens.
#[gpui::test]
fn present_now_in_a_window_without_a_native_view_only_edits(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    editor.update(cx, |e, _| e.options_mut().present_now = true);
    select(&editor, cx, 0, 2);
    editor.update_in(cx, |e, window, cx| e.press_backspace(window, cx));
    assert_eq!(loro_text(&editor, cx, 0), "正\n");
    editor.update(cx, |e, _| assert!(e.hooks.is_none()));
}

/// The system's hook itself, on a window without a native view: on macOS it
/// finds no AppKit view and sends nothing; elsewhere it is the trait's
/// empty default.
#[gpui::test]
fn the_system_hook_leaves_a_window_without_a_native_view_alone(cx: &mut TestAppContext) {
    let (editor, cx) = editor(cx, &[&[(BlockKind::Body, "正文")]]);
    let ime = SystemIme::detached();
    cx.update(|window, _| {
        ime.present_now(window);
        ime.present_now(window);
    });
    assert_eq!(loro_text(&editor, cx, 0), "正文\n");
}
