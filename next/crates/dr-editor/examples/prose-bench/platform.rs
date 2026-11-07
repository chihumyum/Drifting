//! Process metrics, display facts and the editor's platform hooks, for
//! macOS. (The machine itself and the load average are F8's:
//! `dr_testkit::evidence`.)

use std::time::Duration;

/// User + system CPU time of this process.
pub fn cpu_time() -> Duration {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage fills the struct we own.
    let usage = unsafe {
        libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
        usage.assume_init()
    };
    let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

/// Physical footprint (what Activity Monitor shows as Memory), in bytes.
#[cfg(target_os = "macos")]
pub fn phys_footprint() -> u64 {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: proc_pid_rusage writes a rusage_info_v4 into the buffer.
    unsafe {
        let ok = libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr() as *mut libc::rusage_info_t,
        );
        if ok != 0 {
            return 0;
        }
        info.assume_init().ri_phys_footprint
    }
}

#[cfg(not(target_os = "macos"))]
pub fn phys_footprint() -> u64 {
    0
}

#[cfg(target_os = "macos")]
mod cg {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGDisplayIsBuiltin(display: u32) -> u32;
        pub fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
        pub fn CGDisplayModeGetRefreshRate(mode: *mut c_void) -> f64;
        pub fn CGDisplayModeRelease(mode: *mut c_void);
    }
}

/// Whether the display is the built-in panel, and its refresh rate in Hz
/// (ProMotion panels report 120 as their maximum).
#[cfg(target_os = "macos")]
pub fn display_facts(display_id: u64) -> (bool, f64) {
    let id = display_id as u32;
    // SAFETY: plain CoreGraphics queries on a display id GPUI gave us.
    unsafe {
        let builtin = cg::CGDisplayIsBuiltin(id) != 0;
        let mode = cg::CGDisplayCopyDisplayMode(id);
        let mut rate = 0.0;
        if !mode.is_null() {
            rate = cg::CGDisplayModeGetRefreshRate(mode);
            cg::CGDisplayModeRelease(mode);
        }
        if rate == 0.0 && builtin {
            rate = 120.0;
        }
        (builtin, rate)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn display_facts(_display_id: u64) -> (bool, f64) {
    (false, 0.0)
}

/// Draw right after an edit instead of on the next display-link tick, for
/// editors opened from now on. Off by default (stock GPUI timing);
/// `PROSE_BENCH_PRESENT_NOW=1` turns it on.
pub static IMMEDIATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Keep the caret solid (no blink frames), for trace measurements.
pub static NO_BLINK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The editor's platform hooks on macOS.
pub struct MacHooks;

impl gpui_prose::PlatformHooks for MacHooks {
    fn present_now(&self, window: &gpui::Window) {
        #[cfg(target_os = "macos")]
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let Ok(handle) = HasWindowHandle::window_handle(window) else {
                return;
            };
            if let RawWindowHandle::AppKit(appkit) = handle.as_raw() {
                // SAFETY: GPUI's own content view, on the main thread; GPUI
                // sends the same message when it shows a window.
                unsafe {
                    use objc2::{msg_send, runtime::AnyObject};
                    let view = appkit.ns_view.as_ptr() as *mut AnyObject;
                    let _: () = msg_send![view, setNeedsDisplay: true];
                }
            }
        }
    }

    fn discard_marked_text(&self) {
        #[cfg(target_os = "macos")]
        // SAFETY: class method lookup and a message to the current input
        // context, on the main thread, exactly as GPUI's own
        // `invalidateCharacterCoordinates` call does.
        unsafe {
            use objc2::{class, msg_send, runtime::AnyObject};
            let context: *mut AnyObject =
                msg_send![class!(NSTextInputContext), currentInputContext];
            if !context.is_null() {
                let _: () = msg_send![context, discardMarkedText];
            }
        }
    }
}
