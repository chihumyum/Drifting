//! Route macOS Quit through the flush-before-quit barrier.
//!
//! Cmd+Q, the application and Dock menus, AppleScript and logout all end in
//! `-[NSApplication terminate:]`. tao's application delegate does not
//! implement `applicationShouldTerminate:`, so AppKit terminates at once:
//! Tauri never emits `ExitRequested` for it, and the renderer never saves the
//! active editor, drains Yjs or refreshes the Markdown projection, so edits
//! still in flight are lost. Cancel that termination and run the same flushed
//! shutdown as an exit request. It ends with `AppHandle::exit`, which stops the
//! run loop without asking the delegate again.

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use tauri::AppHandle;

use crate::{request_flushed_shutdown, state::ShutdownAction};

static APP: OnceLock<AppHandle> = OnceLock::new();

// NSApplicationTerminateReply
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

extern "C-unwind" fn application_should_terminate(
    _: &AnyObject,
    _: Sel,
    _: *mut AnyObject,
) -> usize {
    match APP.get() {
        Some(app) if request_flushed_shutdown(app, ShutdownAction::ExitApp) => TERMINATE_CANCEL,
        // No renderer to flush: let AppKit finish.
        _ => TERMINATE_NOW,
    }
}

/// Install once, after the event loop registered tao's delegate class.
pub(crate) fn route_terminate_through_flush(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let Some(class) = AnyClass::get(c"TaoAppDelegateParent") else {
        eprintln!(
            "[quit] tao application delegate not found; Quit will skip the persistence flush"
        );
        return;
    };
    let handler: extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize =
        application_should_terminate;
    // SAFETY: the signature matches the "Q@:@" encoding of
    // `-applicationShouldTerminate:`, and tao's class does not define it.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            objc2::sel!(applicationShouldTerminate:),
            std::mem::transmute::<
                extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(handler),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!(
            "[quit] applicationShouldTerminate: already defined; Quit keeps its existing handler"
        );
        return;
    }
    // AppKit records which optional methods a delegate implements when it is
    // assigned. Assign tao's delegate (which tao itself retains) again so
    // NSApplication sees the method just added.
    unsafe {
        let ns_app: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = objc2::msg_send![ns_app, delegate];
        let is_tao: bool = !delegate.is_null() && objc2::msg_send![delegate, isKindOfClass: class];
        if !is_tao {
            eprintln!("[quit] NSApp delegate is not tao's; Quit will skip the persistence flush");
            return;
        }
        let _: () = objc2::msg_send![ns_app, setDelegate: std::ptr::null_mut::<AnyObject>()];
        let _: () = objc2::msg_send![ns_app, setDelegate: delegate];
    }
}
