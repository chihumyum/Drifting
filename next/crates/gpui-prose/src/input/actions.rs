//! Editor actions and their default key bindings (macOS conventions).
//!
//! Only non-printable keys and chords with ⌘ or ⌥ are bound, so every
//! printable key reaches the input method first: GPUI's test for "is a CJK
//! input method active" can be fooled (zed#59882), and an editor that binds no
//! plain printable key is not affected by it.

use gpui::{App, KeyBinding, actions};

actions!(
    prose_editor,
    [
        MoveLeft,
        MoveRight,
        MoveUp,
        MoveDown,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        MoveWordLeft,
        MoveWordRight,
        SelectWordLeft,
        SelectWordRight,
        MoveToLineStart,
        MoveToLineEnd,
        SelectToLineStart,
        SelectToLineEnd,
        MoveToChapterStart,
        MoveToChapterEnd,
        SelectToChapterStart,
        SelectToChapterEnd,
        SelectAll,
        Backspace,
        Delete,
        DeleteWordBackward,
        DeleteWordForward,
        DeleteToLineStart,
        Newline,
        Undo,
        Redo,
        Copy,
        Cut,
        Paste,
        SetBody,
        SetH1,
        SetH2,
        SetH3,
        ToggleBold,
        ToggleItalic,
        ToggleUnderline,
        ToggleStrikethrough,
    ]
);

/// The key context of the editor.
pub const KEY_CONTEXT: &str = "ProseEditor";

/// Binds the default keys in the editor's key context.
pub fn bind_keys(cx: &mut App) {
    let ctx = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("left", MoveLeft, ctx),
        KeyBinding::new("right", MoveRight, ctx),
        KeyBinding::new("up", MoveUp, ctx),
        KeyBinding::new("down", MoveDown, ctx),
        KeyBinding::new("shift-left", SelectLeft, ctx),
        KeyBinding::new("shift-right", SelectRight, ctx),
        KeyBinding::new("shift-up", SelectUp, ctx),
        KeyBinding::new("shift-down", SelectDown, ctx),
        KeyBinding::new("alt-left", MoveWordLeft, ctx),
        KeyBinding::new("alt-right", MoveWordRight, ctx),
        KeyBinding::new("alt-shift-left", SelectWordLeft, ctx),
        KeyBinding::new("alt-shift-right", SelectWordRight, ctx),
        KeyBinding::new("cmd-left", MoveToLineStart, ctx),
        KeyBinding::new("cmd-right", MoveToLineEnd, ctx),
        KeyBinding::new("home", MoveToLineStart, ctx),
        KeyBinding::new("end", MoveToLineEnd, ctx),
        KeyBinding::new("cmd-shift-left", SelectToLineStart, ctx),
        KeyBinding::new("cmd-shift-right", SelectToLineEnd, ctx),
        KeyBinding::new("cmd-up", MoveToChapterStart, ctx),
        KeyBinding::new("cmd-down", MoveToChapterEnd, ctx),
        KeyBinding::new("cmd-shift-up", SelectToChapterStart, ctx),
        KeyBinding::new("cmd-shift-down", SelectToChapterEnd, ctx),
        KeyBinding::new("cmd-a", SelectAll, ctx),
        KeyBinding::new("backspace", Backspace, ctx),
        KeyBinding::new("shift-backspace", Backspace, ctx),
        KeyBinding::new("delete", Delete, ctx),
        KeyBinding::new("alt-backspace", DeleteWordBackward, ctx),
        KeyBinding::new("alt-delete", DeleteWordForward, ctx),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, ctx),
        KeyBinding::new("enter", Newline, ctx),
        KeyBinding::new("cmd-z", Undo, ctx),
        KeyBinding::new("cmd-shift-z", Redo, ctx),
        KeyBinding::new("cmd-c", Copy, ctx),
        KeyBinding::new("cmd-x", Cut, ctx),
        KeyBinding::new("cmd-v", Paste, ctx),
        KeyBinding::new("cmd-0", SetBody, ctx),
        KeyBinding::new("cmd-1", SetH1, ctx),
        KeyBinding::new("cmd-2", SetH2, ctx),
        KeyBinding::new("cmd-3", SetH3, ctx),
        KeyBinding::new("cmd-b", ToggleBold, ctx),
        KeyBinding::new("cmd-i", ToggleItalic, ctx),
        KeyBinding::new("cmd-u", ToggleUnderline, ctx),
        KeyBinding::new("cmd-shift-x", ToggleStrikethrough, ctx),
    ]);
}
