//! Telling the system input method to drop its marked text, which GPUI
//! v1.27 has no call for (G3 in the F4 patch ledger would add one), and
//! telling input that arrives too late.
//!
//! When the editor loses focus mid-composition it drops the marked text and
//! asks the input method to drop it too (the author's rule,
//! [`gpui_ime::BLUR_RULE`]: discard, never commit half-typed pinyin).
//! [`SystemIme`] is that request for macOS and Windows, as a
//! [`PlatformHooks`]:
//!
//! - **macOS**: `[[NSTextInputContext currentInputContext] discardMarkedText]`.
//! - **Windows** (IMM32, G4): `ImmGetContext(hwnd)` →
//!   `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` →
//!   `ImmReleaseContext`.
//!
//! # How GPUI v1.27's Windows backend drives the editor
//!
//! `gpui_windows` speaks IMM32 only (input methods built on TSF, Microsoft
//! Pinyin among them, reach it through Windows' IMM32 compatibility layer):
//!
//! - `WM_IME_COMPOSITION` with `GCS_RESULTSTR` → `replace_text_in_range(None,
//!   result)`; with `GCS_COMPSTR` → `replace_and_mark_text_in_range(None,
//!   composition, cursor..cursor)`, the cursor in UTF-16 units of the
//!   composition (both flags in one message: the result first). With no
//!   flags at all (the Japanese IME clearing its composition, or the echo of
//!   a `CPS_CANCEL`) → `replace_text_in_range(None, "")`, which the editor
//!   takes as "drop the marked text" and never as "delete the selection".
//! - `WM_CHAR` → `replace_text_in_range(None, ch)`; `unmark_text` is never
//!   called.
//! - `WM_IME_STARTCOMPOSITION` places the candidate window at
//!   `bounds_for_range(selected_text_range)`; the editor's
//!   `invalidate_character_coordinates` moves it as the caret moves.
//! - After every frame, if the focused element stopped taking text, GPUI
//!   sends `CPS_COMPLETE` (commit) — only while the window has the keyboard,
//!   because the input context belongs to the whole thread — and detaches
//!   the input context.
//! - A call into the editor while GPUI is already inside an update (an
//!   input method answering a notification synchronously) is dropped:
//!   GPUI's handler finds the app borrowed and gives up.
//!
//! # Where the editor hooks in, without changing GPUI
//!
//! 1. **Focus moving inside the window** (to the find bar, a sidebar): GPUI
//!    dispatches focus events while drawing, after it has installed the new
//!    element's input handler and before its own `CPS_COMPLETE`. The
//!    editor's blur handler drops the marked text and sends `CPS_CANCEL`;
//!    the input method's synchronous answer is dropped (the app is borrowed,
//!    and the handler is no longer the editor's); GPUI's `CPS_COMPLETE`
//!    then finds nothing to commit. Without the cancel the half-typed
//!    pinyin would carry over into the next text field, the input context
//!    being the thread's.
//! 2. **The window losing the keyboard** (another application, another
//!    Drifting window): GPUI learns of it asynchronously (`WM_ACTIVATE`
//!    spawns its callback), so the blur comes a frame later. If the input
//!    method commits its composition as focus leaves, that commit arrives
//!    first, while the window no longer has the keyboard
//!    ([`SystemIme::has_keyboard`]: `GetFocus()` is no longer this window);
//!    the editor drops it as late input (`input/ime.rs`) together with its
//!    marked text and sends `CPS_CANCEL`. If the input method keeps the
//!    composition instead, the blur that follows cancels it, here without
//!    checking `GetFocus()`: the composition in the thread's context is
//!    still the editor's (nobody can start another one within the frame),
//!    and leaving it would bring it back in whatever field the author types
//!    in next.
//!
//! The editor installs one by itself when input starts in a window with a
//! native handle, unless the host set its own hooks
//! ([`crate::ProseEditor::set_platform_hooks`]); test windows have no handle
//! and get none.

use gpui::Window;

use crate::platform::PlatformHooks;

/// The system input method of one window.
pub struct SystemIme {
    #[cfg(target_os = "windows")]
    hwnd: isize,
}

impl SystemIme {
    /// The input method of `window`; `None` for a window without a native
    /// handle (GPUI's test windows) or on a platform without support.
    pub fn for_window(window: &Window) -> Option<SystemIme> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        match handle.as_raw() {
            #[cfg(target_os = "macos")]
            RawWindowHandle::AppKit(_) => Some(SystemIme {}),
            #[cfg(target_os = "windows")]
            RawWindowHandle::Win32(win32) => Some(SystemIme {
                hwnd: win32.hwnd.get(),
            }),
            _ => None,
        }
    }

    #[cfg(target_os = "windows")]
    fn hwnd(&self) -> windows::Win32::Foundation::HWND {
        windows::Win32::Foundation::HWND(self.hwnd as *mut core::ffi::c_void)
    }
}

impl PlatformHooks for SystemIme {
    fn discard_marked_text(&self) {
        #[cfg(target_os = "macos")]
        // SAFETY: a class-method lookup and one message to the current input
        // context, on the main thread (GPUI calls the editor there), as GPUI
        // itself does for `invalidateCharacterCoordinates`.
        unsafe {
            use objc2::{class, msg_send, runtime::AnyObject};
            let context: *mut AnyObject =
                msg_send![class!(NSTextInputContext), currentInputContext];
            if !context.is_null() {
                let _: () = msg_send![context, discardMarkedText];
            }
        }
        #[cfg(target_os = "windows")]
        // SAFETY: the window's own handle, valid while the editor in it
        // lives; the context is released right after, as GPUI's Windows
        // backend does with every context it gets.
        unsafe {
            use windows::Win32::UI::Input::Ime::{
                CPS_CANCEL, ImmGetContext, ImmNotifyIME, ImmReleaseContext, NI_COMPOSITIONSTR,
            };
            let hwnd = self.hwnd();
            let himc = ImmGetContext(hwnd);
            if !himc.is_invalid() {
                let _ = ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
                let _ = ImmReleaseContext(hwnd, himc);
            }
        }
    }

    /// Whether this window has the keyboard focus (GPUI's windows have no
    /// child windows, so the window itself). macOS keeps the default
    /// (always).
    #[cfg(target_os = "windows")]
    fn has_keyboard(&self) -> bool {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
        // SAFETY: `GetFocus` only reads the calling thread's focus; GPUI
        // calls the editor on the window's own thread.
        unsafe { GetFocus() == self.hwnd() }
    }
}

impl crate::ProseEditor {
    /// Installs [`SystemIme`] for this editor's window if the host set no
    /// hooks (called when input starts).
    pub(crate) fn ensure_system_ime(&mut self, window: &Window) {
        if self.hooks.is_none()
            && let Some(ime) = SystemIme::for_window(window)
        {
            self.hooks = Some(std::rc::Rc::new(ime));
        }
    }

    /// Whether the window has the keyboard, by the hooks (installing the
    /// system's first); `true` without hooks.
    pub(crate) fn window_has_keyboard(&mut self, window: &Window) -> bool {
        self.ensure_system_ime(window);
        self.hooks.as_ref().is_none_or(|hooks| hooks.has_keyboard())
    }
}
