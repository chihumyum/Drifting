//! Editor actions and their default key bindings, in two schemes: macOS
//! (⌘ for commands, ⌥ for words and paragraphs) and Windows (Ctrl for both;
//! also what Linux uses). [`bind_keys`] binds the scheme of the platform it
//! runs on; [`key_bindings`] gives either scheme's list (for a shortcut
//! registry, and for tests on another platform).
//!
//! Only non-printable keys and chords with ⌘, ⌥ or Ctrl are bound, so every
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
        MoveToParagraphStart,
        MoveToParagraphEnd,
        MoveToNextParagraph,
        SelectToParagraphStart,
        SelectToParagraphEnd,
        SelectToNextParagraph,
        FindNext,
        FindPrevious,
        UseSelectionForFind,
        IndentListItem,
        OutdentListItem,
        ToggleTask,
    ]
);

/// The key context of the editor.
pub const KEY_CONTEXT: &str = "ProseEditor";

/// Which platform's conventions the key bindings follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyScheme {
    /// ⌘ for commands, ⌥ for words and paragraphs, ⌘←/⌘→ for row edges,
    /// ⌘↑/⌘↓ for the chapter's ends.
    Mac,
    /// Ctrl for commands and words, Home/End for row edges, Ctrl+Home/End
    /// for the chapter's ends, Ctrl+↑/↓ for paragraphs, F3 to find again.
    Windows,
}

impl KeyScheme {
    /// The scheme of the platform this build runs on (Linux follows Windows).
    pub fn native() -> KeyScheme {
        if cfg!(target_os = "macos") {
            KeyScheme::Mac
        } else {
            KeyScheme::Windows
        }
    }
}

/// Binds the default keys of this platform in the editor's key context.
pub fn bind_keys(cx: &mut App) {
    bind_keys_for(KeyScheme::native(), cx);
}

/// Binds `scheme`'s keys in the editor's key context.
pub fn bind_keys_for(scheme: KeyScheme, cx: &mut App) {
    cx.bind_keys(key_bindings(scheme));
}

/// `scheme`'s key bindings, in the editor's key context.
pub fn key_bindings(scheme: KeyScheme) -> Vec<KeyBinding> {
    let ctx = Some(KEY_CONTEXT);
    // Keys both schemes share.
    let mut keys = vec![
        KeyBinding::new("left", MoveLeft, ctx),
        KeyBinding::new("right", MoveRight, ctx),
        KeyBinding::new("up", MoveUp, ctx),
        KeyBinding::new("down", MoveDown, ctx),
        KeyBinding::new("shift-left", SelectLeft, ctx),
        KeyBinding::new("shift-right", SelectRight, ctx),
        KeyBinding::new("shift-up", SelectUp, ctx),
        KeyBinding::new("shift-down", SelectDown, ctx),
        KeyBinding::new("home", MoveToLineStart, ctx),
        KeyBinding::new("end", MoveToLineEnd, ctx),
        KeyBinding::new("shift-home", SelectToLineStart, ctx),
        KeyBinding::new("shift-end", SelectToLineEnd, ctx),
        KeyBinding::new("backspace", Backspace, ctx),
        KeyBinding::new("shift-backspace", Backspace, ctx),
        KeyBinding::new("delete", Delete, ctx),
        KeyBinding::new("enter", Newline, ctx),
        // List items only; elsewhere the key goes on to the host.
        KeyBinding::new("tab", IndentListItem, ctx),
        KeyBinding::new("shift-tab", OutdentListItem, ctx),
    ];
    match scheme {
        KeyScheme::Mac => keys.extend([
            KeyBinding::new("alt-left", MoveWordLeft, ctx),
            KeyBinding::new("alt-right", MoveWordRight, ctx),
            KeyBinding::new("alt-shift-left", SelectWordLeft, ctx),
            KeyBinding::new("alt-shift-right", SelectWordRight, ctx),
            KeyBinding::new("alt-up", MoveToParagraphStart, ctx),
            KeyBinding::new("alt-down", MoveToParagraphEnd, ctx),
            KeyBinding::new("alt-shift-up", SelectToParagraphStart, ctx),
            KeyBinding::new("alt-shift-down", SelectToParagraphEnd, ctx),
            KeyBinding::new("cmd-left", MoveToLineStart, ctx),
            KeyBinding::new("cmd-right", MoveToLineEnd, ctx),
            KeyBinding::new("cmd-shift-left", SelectToLineStart, ctx),
            KeyBinding::new("cmd-shift-right", SelectToLineEnd, ctx),
            KeyBinding::new("cmd-up", MoveToChapterStart, ctx),
            KeyBinding::new("cmd-down", MoveToChapterEnd, ctx),
            KeyBinding::new("cmd-shift-up", SelectToChapterStart, ctx),
            KeyBinding::new("cmd-shift-down", SelectToChapterEnd, ctx),
            KeyBinding::new("cmd-a", SelectAll, ctx),
            KeyBinding::new("alt-backspace", DeleteWordBackward, ctx),
            KeyBinding::new("alt-delete", DeleteWordForward, ctx),
            KeyBinding::new("cmd-backspace", DeleteToLineStart, ctx),
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
            KeyBinding::new("cmd-g", FindNext, ctx),
            KeyBinding::new("cmd-shift-g", FindPrevious, ctx),
            KeyBinding::new("cmd-e", UseSelectionForFind, ctx),
            KeyBinding::new("cmd-enter", ToggleTask, ctx),
        ]),
        KeyScheme::Windows => keys.extend([
            KeyBinding::new("ctrl-left", MoveWordLeft, ctx),
            KeyBinding::new("ctrl-right", MoveWordRight, ctx),
            KeyBinding::new("ctrl-shift-left", SelectWordLeft, ctx),
            KeyBinding::new("ctrl-shift-right", SelectWordRight, ctx),
            KeyBinding::new("ctrl-up", MoveToParagraphStart, ctx),
            KeyBinding::new("ctrl-down", MoveToNextParagraph, ctx),
            KeyBinding::new("ctrl-shift-up", SelectToParagraphStart, ctx),
            KeyBinding::new("ctrl-shift-down", SelectToNextParagraph, ctx),
            KeyBinding::new("ctrl-home", MoveToChapterStart, ctx),
            KeyBinding::new("ctrl-end", MoveToChapterEnd, ctx),
            KeyBinding::new("ctrl-shift-home", SelectToChapterStart, ctx),
            KeyBinding::new("ctrl-shift-end", SelectToChapterEnd, ctx),
            KeyBinding::new("ctrl-a", SelectAll, ctx),
            KeyBinding::new("ctrl-backspace", DeleteWordBackward, ctx),
            KeyBinding::new("ctrl-delete", DeleteWordForward, ctx),
            KeyBinding::new("ctrl-z", Undo, ctx),
            KeyBinding::new("ctrl-y", Redo, ctx),
            KeyBinding::new("ctrl-shift-z", Redo, ctx),
            KeyBinding::new("ctrl-c", Copy, ctx),
            KeyBinding::new("ctrl-insert", Copy, ctx),
            KeyBinding::new("ctrl-x", Cut, ctx),
            KeyBinding::new("shift-delete", Cut, ctx),
            KeyBinding::new("ctrl-v", Paste, ctx),
            KeyBinding::new("shift-insert", Paste, ctx),
            KeyBinding::new("ctrl-0", SetBody, ctx),
            KeyBinding::new("ctrl-1", SetH1, ctx),
            KeyBinding::new("ctrl-2", SetH2, ctx),
            KeyBinding::new("ctrl-3", SetH3, ctx),
            KeyBinding::new("ctrl-b", ToggleBold, ctx),
            KeyBinding::new("ctrl-i", ToggleItalic, ctx),
            KeyBinding::new("ctrl-u", ToggleUnderline, ctx),
            KeyBinding::new("ctrl-shift-x", ToggleStrikethrough, ctx),
            KeyBinding::new("f3", FindNext, ctx),
            KeyBinding::new("shift-f3", FindPrevious, ctx),
            KeyBinding::new("ctrl-enter", ToggleTask, ctx),
        ]),
    }
    keys
}
