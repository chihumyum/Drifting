//! What the editor needs from the platform that GPUI v1.27 does not offer.

use gpui::Window;

/// Platform hooks the app supplies (a GPUI patch could make them
/// unnecessary; see the F4 notes, "GPUI patches").
pub trait PlatformHooks: 'static {
    /// Tell the system input method to drop its marked text
    /// (`[NSTextInputContext discardMarkedText]` on macOS,
    /// `ImmNotifyIME(…, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` on Windows).
    fn discard_marked_text(&self, window: &Window);

    /// Whether the editor's window has the keyboard right now. Input that
    /// arrives while it has not (on Windows, an input method committing its
    /// composition as focus moves to another window) is late: the editor
    /// drops it and its marked text instead of writing it. Default: always
    /// (macOS, test windows).
    fn has_keyboard(&self) -> bool {
        true
    }

    /// Whether the event the application is handling right now is a pointer
    /// button going down. On macOS GPUI hands a press to the input method
    /// before the editor hears of it, and an input method may answer by
    /// committing its marked text as typed; a commit that arrives during a
    /// press is dropped with the marked text instead (`input/ime.rs`), the
    /// same as a press the editor handles itself. Default: never (Windows,
    /// where the backend does not hand presses over; test windows).
    fn pointer_press_in_flight(&self) -> bool {
        false
    }

    /// Ask for this frame to be drawn now instead of on the next display-link
    /// tick (on macOS `[view setNeedsDisplay:YES]`, which makes Core
    /// Animation call GPUI's `displayLayer:` when the current event ends;
    /// [`crate::input::system_ime::SystemIme`] does that). Called once after
    /// every edit and composition update while
    /// [`crate::EditorOptions::present_now`] is on. Default: nothing (other
    /// platforms, test windows).
    fn present_now(&self, _window: &Window) {}
}
