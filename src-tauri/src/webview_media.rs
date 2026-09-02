//! WebKit media-capture opt-in for macOS.
//!
//! An embedded `WKWebView` on macOS hides `navigator.mediaDevices` entirely
//! until the host application enables WebKit's private `mediaDevicesEnabled`
//! preference: `isSecureContext` is true and `MediaRecorder` exists, but
//! `getUserMedia` is simply absent, so the renderer's support check fails
//! before any microphone permission prompt can appear. wry already grants the
//! WebKit-level capture permission in its UI delegate; this is the missing
//! half. The preference propagates to a live web view, so applying it right
//! after the main window is built is sufficient. iOS exposes the API without
//! this opt-in and is verified separately on the simulator/device gate.

use tauri::WebviewWindow;

pub(crate) fn enable_media_devices(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| unsafe {
        use objc2::runtime::NSObjectProtocol;
        use objc2_foundation::{ns_string, NSNumber, NSObjectNSKeyValueCoding};
        use objc2_web_kit::WKWebView;

        let webview: &WKWebView = &*webview.inner().cast();
        let preferences = webview.configuration().preferences();
        // Private KVC key. Only set it while this WebKit build still exposes
        // the accessor, so a removed private API degrades to the renderer's
        // "unsupported" state instead of an unknown-key exception.
        if !preferences.respondsToSelector(objc2::sel!(_setMediaDevicesEnabled:)) {
            return;
        }
        let yes = NSNumber::numberWithBool(true);
        preferences.setValue_forKey(Some(&yes), ns_string!("mediaDevicesEnabled"));
    })
}
