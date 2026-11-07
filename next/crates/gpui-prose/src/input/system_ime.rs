//! Telling the system input method to drop its marked text, which GPUI
//! v1.27 has no call for (G3 in the F4 patch ledger would add one).
//!
//! When the editor loses focus mid-composition it drops the marked text and
//! asks the input method to drop it too (the author's rule: discard, never
//! commit half-typed pinyin). [`SystemIme`] is that request for macOS and
//! Windows, as a [`PlatformHooks`]:
//!
//! - **macOS**: `[[NSTextInputContext currentInputContext] discardMarkedText]`.
//! - **Windows** (IMM32, G4): `ImmGetContext(hwnd)` →
//!   `ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` →
//!   `ImmReleaseContext`. GPUI's own Windows backend sends `CPS_COMPLETE`
//!   (commit) when the focused element stops accepting text; the editor's
//!   blur handler runs first, inside the frame, so the composition is
//!   already cancelled by then and the commit finds nothing. When focus
//!   moves to another text field (the find bar), GPUI sends nothing and the
//!   input context is the thread's, so without the cancel the half-typed
//!   pinyin would carry over into that field.
//!
//! The editor installs one by itself when a composition starts in a window
//! with a native handle, unless the host set its own hooks
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
            use windows::Win32::{
                Foundation::HWND,
                UI::Input::Ime::{
                    CPS_CANCEL, ImmGetContext, ImmNotifyIME, ImmReleaseContext, NI_COMPOSITIONSTR,
                },
            };
            let hwnd = HWND(self.hwnd as *mut core::ffi::c_void);
            let himc = ImmGetContext(hwnd);
            if !himc.is_invalid() {
                let _ = ImmNotifyIME(himc, NI_COMPOSITIONSTR, CPS_CANCEL, 0);
                let _ = ImmReleaseContext(hwnd, himc);
            }
        }
    }
}

impl crate::ProseEditor {
    /// Installs [`SystemIme`] for this editor's window if the host set no
    /// hooks (called when a composition starts).
    pub(crate) fn ensure_system_ime(&mut self, window: &Window) {
        if self.hooks.is_none()
            && let Some(ime) = SystemIme::for_window(window)
        {
            self.hooks = Some(std::rc::Rc::new(ime));
        }
    }
}
