//! What the editor needs from the platform that GPUI v1.27 does not offer.

use gpui::Window;

/// Platform hooks the app supplies (a GPUI patch could make them
/// unnecessary; see the F4 notes, "GPUI patches").
pub trait PlatformHooks: 'static {
    /// Tell the system input method to drop its marked text
    /// (`[NSTextInputContext discardMarkedText]` on macOS,
    /// `ImmNotifyIME(…, NI_COMPOSITIONSTR, CPS_CANCEL, 0)` on Windows).
    fn discard_marked_text(&self);

    /// Ask for this frame to be drawn now instead of on the next display-link
    /// tick (on macOS `[view setNeedsDisplay:YES]`, which makes Core
    /// Animation call GPUI's `displayLayer:` when the current event ends).
    /// Called after every edit and composition update while
    /// [`crate::EditorOptions::present_now`] is on.
    fn present_now(&self, _window: &Window) {}
}
