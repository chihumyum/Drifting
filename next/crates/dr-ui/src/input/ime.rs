//! What the single-line input adds to `gpui-ime`'s [`LineComposer`]: where
//! the caret may stop (grapheme clusters, from `unicode-segmentation`) and
//! the call that makes the system input method drop its marked text, which
//! GPUI v1.27 does not offer.
//!
//! Losing focus mid-composition follows [`gpui_ime::BLUR_RULE`] (the
//! author's decision, 2026-11-07): the field clears the marked text and asks
//! the system to discard it too, so nothing half-typed is committed or left
//! in the candidate window.

use std::rc::Rc;

use gpui::{App, Global, Window};
use gpui_ime::Boundaries;
use unicode_segmentation::UnicodeSegmentation as _;

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
/// context, only while that window has the keyboard (the context is per
/// thread, as GPUI's own backend notes).
#[cfg(windows)]
pub fn system_discard(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::{
        Foundation::HWND,
        UI::Input::{
            Ime::{CPS_CANCEL, ImmGetContext, ImmNotifyIME, ImmReleaseContext, NI_COMPOSITIONSTR},
            KeyboardAndMouse::GetFocus,
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
        if GetFocus() != hwnd {
            return;
        }
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
    fn losing_focus_follows_the_shared_rule() {
        assert_eq!(gpui_ime::BLUR_RULE, gpui_ime::BlurRule::Discard);
        let mut c = LineComposer::new("林");
        c.replace_and_mark(None, "lan", Some(3..3));
        assert_eq!(c.blur(), Change::Composing);
        assert_eq!(c.text(), "林");
    }
}
