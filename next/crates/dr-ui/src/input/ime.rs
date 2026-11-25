//! What the single-line input adds to `gpui-ime`'s [`LineComposer`]: where
//! the caret may stop (grapheme clusters, from `unicode-segmentation`) and
//! the call that makes the system input method drop its marked text, which
//! GPUI v1.27 does not offer.
//!
//! Losing focus mid-composition follows [`gpui_ime::BLUR_RULE`] (the
//! author's decision, 2026-11-07): the field clears the marked text and asks
//! the system to discard it too, so nothing half-typed is committed or left
//! in the candidate window.

use std::{
    ops::Range,
    rc::Rc,
    sync::OnceLock,
    time::{Duration, Instant},
};

use gpui::{App, Global, Window};
use gpui_ime::{Boundaries, LineComposer};
use icu_segmenter::{WordSegmenter, WordSegmenterBorrowed, options::WordBreakInvariantOptions};
use unicode_segmentation::UnicodeSegmentation as _;

/// A segment between two word boundaries; `word` is true for letters,
/// ideographs, and digits (not whitespace or punctuation).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordSegment {
    pub range: Range<usize>,
    pub word: bool,
}

fn word_segmenter() -> &'static WordSegmenterBorrowed<'static> {
    static SEGMENTER: OnceLock<WordSegmenterBorrowed<'static>> = OnceLock::new();
    SEGMENTER.get_or_init(|| WordSegmenter::new_dictionary(WordBreakInvariantOptions::default()))
}

/// ICU4X dictionary word segments (handles CJK dictionary words + Latin UAX #29).
pub fn word_segments(text: &str) -> Vec<WordSegment> {
    let mut out = Vec::new();
    let mut start = 0;
    for (end, kind) in word_segmenter().segment_str(text).iter_with_word_type() {
        if end > start {
            out.push(WordSegment {
                range: start..end,
                word: kind.is_word_like(),
            });
        }
        start = end;
    }
    out
}

/// The word (or whitespace/punctuation segment) around byte offset `at`:
/// what a double-click selects in `TextField` and `TextArea`.
pub fn word_range(text: &str, at: usize) -> Range<usize> {
    if text.is_empty() {
        return 0..0;
    }
    let segments = word_segments(text);
    let at = at.min(text.len());
    segments
        .iter()
        .find(|s| s.range.start <= at && at < s.range.end)
        .or_else(|| segments.last())
        .map_or(at..at, |s| s.range.clone())
}

/// Where ⌥← / Ctrl+← / ⌥⌫ / Ctrl+Backspace goes from byte offset `at`:
/// the start of the previous word (skipping whitespace & punctuation), or `0`.
pub fn prev_word_start(text: &str, at: usize) -> usize {
    let at = at.min(text.len());
    if at == 0 {
        return 0;
    }
    word_segments(text)
        .into_iter()
        .rev()
        .find(|s| s.word && s.range.start < at)
        .map_or(0, |s| s.range.start)
}

/// Where ⌥→ / Ctrl+→ / ⌥⌦ / Ctrl+Delete goes from byte offset `at`:
/// the end of the next word (skipping whitespace & punctuation), or `text.len()`.
pub fn next_word_end(text: &str, at: usize) -> usize {
    let at = at.min(text.len());
    if at >= text.len() {
        return text.len();
    }
    word_segments(text)
        .into_iter()
        .find(|s| s.word && s.range.end > at)
        .map_or(text.len(), |s| s.range.end)
}

/// One committed text + selection snapshot for plain-input undo/redo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditSnapshot {
    pub text: String,
    pub selection: Range<usize>,
    pub reversed: bool,
}

impl EditSnapshot {
    pub fn from_composer(composer: &LineComposer) -> Self {
        match composer.marked() {
            Some(m) => Self {
                text: composer.committed(),
                selection: m.start..m.start,
                reversed: false,
            },
            None => Self {
                text: composer.text().to_owned(),
                selection: composer.selection(),
                reversed: composer.reversed(),
            },
        }
    }

    pub fn restore_into(&self, composer: &mut LineComposer) {
        composer.set_text(self.text.clone());
        let len = composer.text().len();
        let start = self.selection.start.min(len);
        let end = self.selection.end.min(len);
        if self.reversed {
            composer.move_to(end);
            composer.select_to(start);
        } else {
            composer.move_to(start);
            composer.select_to(end);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
    Insert,
    Delete,
    Other,
}

/// Bounded undo/redo stack for `TextField` and `TextArea`, coalescing
/// consecutive single-burst typing or deletions within 600ms.
#[derive(Default)]
pub struct EditHistory {
    undo: Vec<EditSnapshot>,
    redo: Vec<EditSnapshot>,
    last_kind: Option<EditKind>,
    last_at: Option<Instant>,
}

const MAX_HISTORY: usize = 200;
const COALESCE_WINDOW: Duration = Duration::from_millis(600);

impl EditHistory {
    pub fn record(&mut self, before: EditSnapshot, kind: EditKind, break_coalesce: bool) {
        self.redo.clear();
        let now = Instant::now();
        let can_coalesce = !break_coalesce
            && matches!(kind, EditKind::Insert | EditKind::Delete)
            && self.last_kind == Some(kind)
            && self
                .last_at
                .is_some_and(|t| now.saturating_duration_since(t) <= COALESCE_WINDOW)
            && !self.undo.is_empty();
        if !can_coalesce {
            if self.undo.len() >= MAX_HISTORY {
                self.undo.remove(0);
            }
            self.undo.push(before);
        }
        self.last_kind = Some(kind);
        self.last_at = Some(now);
    }

    pub fn break_coalesce(&mut self) {
        self.last_kind = None;
        self.last_at = None;
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.last_kind = None;
        self.last_at = None;
    }

    pub fn undo(&mut self, current: EditSnapshot) -> Option<EditSnapshot> {
        let prev = self.undo.pop()?;
        self.redo.push(current);
        self.last_kind = None;
        self.last_at = None;
        Some(prev)
    }

    pub fn redo(&mut self, current: EditSnapshot) -> Option<EditSnapshot> {
        let next = self.redo.pop()?;
        self.undo.push(current);
        self.last_kind = None;
        self.last_at = None;
        Some(next)
    }
}

/// Grapheme-cluster boundaries: a family emoji or a letter with its accent
/// is one step of the caret and one backspace.
#[derive(Clone, Copy, Debug, Default)]
pub struct Graphemes;

impl Boundaries for Graphemes {
    fn prev(&self, text: &str, offset: usize) -> usize {
        text.grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < offset).then_some(i))
            .unwrap_or(0)
    }

    fn next(&self, text: &str, offset: usize) -> usize {
        text.grapheme_indices(true)
            .find_map(|(i, _)| (i > offset).then_some(i))
            .unwrap_or(text.len())
    }
}

/// Replaces the call to the system input method; set by tests and by a host
/// with a better route. Without one, fields use [`system_discard`].
struct DiscardHook(Rc<dyn Fn(&Window)>);

impl Global for DiscardHook {}

/// Has every field call `f` instead of the system input method when it loses
/// focus with marked text.
pub fn set_discard_marked_text(cx: &mut App, f: impl Fn(&Window) + 'static) {
    cx.set_global(DiscardHook(Rc::new(f)));
}

/// Tells the system input method to drop its marked text for `window`.
pub(crate) fn discard_marked_text(window: &Window, cx: &App) {
    match cx.try_global::<DiscardHook>() {
        Some(hook) => (hook.0.clone())(window),
        None => system_discard(window),
    }
}

/// Overrides the synchronous keyboard-focus query, for a host or tests.
/// Unlike GPUI's focus notification, this must reflect a native window
/// switch before an input method can deliver its final composition.
struct KeyboardHook(Rc<dyn Fn(&Window) -> bool>);
impl Global for KeyboardHook {}

pub fn set_window_has_keyboard(cx: &mut App, f: impl Fn(&Window) -> bool + 'static) {
    cx.set_global(KeyboardHook(Rc::new(f)));
}

pub(crate) fn window_has_keyboard(window: &Window, cx: &App) -> bool {
    match cx.try_global::<KeyboardHook>() {
        Some(hook) => (hook.0)(window),
        None => system_has_keyboard(window),
    }
}

#[cfg(windows)]
fn system_has_keyboard(window: &Window) -> bool {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::{Foundation::HWND, UI::Input::KeyboardAndMouse::GetFocus};
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return true; // GPUI test windows have no native handle.
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return true;
    };
    // SAFETY: reads the calling UI thread's focus without mutating it.
    unsafe { GetFocus() == HWND(win32.hwnd.get() as *mut _) }
}

#[cfg(not(windows))]
fn system_has_keyboard(_window: &Window) -> bool {
    true
}

/// `[[view inputContext] discardMarkedText]` on the window's own view (not
/// the current context, which after a window switch belongs to another
/// window).
#[cfg(target_os = "macos")]
pub fn system_discard(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    // GPUI's own `Window::window_handle` is its window id; this is the
    // platform's.
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return;
    };
    // SAFETY: GPUI's own content view, on the main thread; GPUI sends the
    // view the same `inputContext` message for every key and mouse event.
    unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        let view = appkit.ns_view.as_ptr() as *mut AnyObject;
        let context: *mut AnyObject = msg_send![view, inputContext];
        if !context.is_null() {
            let _: () = msg_send![context, discardMarkedText];
        }
    }
}

/// `ImmNotifyIME(…, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` on the window's input
/// context, including after the window loses the keyboard: GPUI delivers
/// blur asynchronously, while the old composition still needs cancelling.
#[cfg(windows)]
pub fn system_discard(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::{
        Foundation::HWND,
        UI::Input::Ime::{
            CPS_CANCEL, ImmGetContext, ImmNotifyIME, ImmReleaseContext, NI_COMPOSITIONSTR,
        },
    };
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = HWND(win32.hwnd.get() as *mut _);
    // SAFETY: plain Win32 calls on our own window, on its thread; the
    // context is released before returning.
    unsafe {
        let himc = ImmGetContext(hwnd);
        if himc.is_invalid() {
            return;
        }
        let _ = ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
        let _ = ImmReleaseContext(hwnd, himc);
    }
}

/// Elsewhere there is no call to make yet.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn system_discard(_window: &Window) {}

#[cfg(test)]
mod tests {
    use gpui_ime::{Change, LineComposer};

    use super::*;

    #[test]
    fn the_caret_steps_over_whole_clusters() {
        let mut c = LineComposer::new("e\u{301}x👨‍👩‍👧");
        c.end();
        assert_eq!(c.backspace(&Graphemes), Change::Committed);
        assert_eq!(c.text(), "e\u{301}x");
        c.home();
        c.right(&Graphemes);
        assert_eq!(c.cursor(), "e\u{301}".len());
        c.select_right(&Graphemes);
        assert_eq!(c.selected_text(), "x");
        c.move_to("e\u{301}".len());
        assert_eq!(c.backspace(&Graphemes), Change::Committed);
        assert_eq!(c.text(), "x");
    }

    #[test]
    fn chinese_and_latin_word_boundaries() {
        let text = "我们今天去公园 hello world";
        assert_eq!(&text[word_range(text, 7)], "今天");
        assert_eq!(&text[word_range(text, text.len() - 2)], "world");
        let end_cn = "我们今天去公园".len();
        assert_eq!(prev_word_start(text, end_cn), "我们今天去".len());
        assert_eq!(prev_word_start(text, "我们今天去".len()), "我们今天".len());
        assert_eq!(next_word_end(text, 0), "我们".len());
        assert_eq!(next_word_end(text, end_cn), "我们今天去公园 hello".len());
    }

    #[test]
    fn edit_history_undo_and_redo() {
        let mut history = EditHistory::default();
        let mut c = LineComposer::new("一");
        let s0 = EditSnapshot::from_composer(&c);
        c.insert("二");
        history.record(s0, EditKind::Other, true);
        let s1 = EditSnapshot::from_composer(&c);
        c.insert("三");
        history.record(s1, EditKind::Other, true);
        assert_eq!(c.text(), "一二三");

        let cur = EditSnapshot::from_composer(&c);
        history.undo(cur).unwrap().restore_into(&mut c);
        assert_eq!(c.text(), "一二");
        let cur = EditSnapshot::from_composer(&c);
        history.undo(cur).unwrap().restore_into(&mut c);
        assert_eq!(c.text(), "一");
        let cur = EditSnapshot::from_composer(&c);
        history.redo(cur).unwrap().restore_into(&mut c);
        assert_eq!(c.text(), "一二");
    }

    #[test]
    fn losing_focus_follows_the_shared_rule() {
        assert_eq!(gpui_ime::BLUR_RULE, gpui_ime::BlurRule::Discard);
        let mut c = LineComposer::new("林");
        c.replace_and_mark(None, "lan", Some(3..3));
        assert_eq!(c.blur(), Change::Composing);
        assert_eq!(c.text(), "林");
    }
}
