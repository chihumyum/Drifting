//! Process metrics and display facts, for macOS. (The machine itself and the
//! load average are F8's: `dr_testkit::evidence`. The editor's platform
//! hooks are gpui-prose's `SystemIme`, which the editor installs itself, as
//! in the app.)

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
