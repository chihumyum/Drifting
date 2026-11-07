//! Process metrics, display facts and the IME hook, for macOS.

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

fn sysctl_string(name: &str) -> String {
    let name = std::ffi::CString::new(name).unwrap();
    let mut len = 0usize;
    // SAFETY: two-step sysctl read into a buffer of the reported size.
    unsafe {
        if libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut len,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return String::new();
        }
        let mut buf = vec![0u8; len];
        if libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return String::new();
        }
        String::from_utf8_lossy(&buf[..len.saturating_sub(1)]).into_owned()
    }
}

fn sysctl_u64(name: &str) -> u64 {
    let name = std::ffi::CString::new(name).unwrap();
    let mut value = 0u64;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: reads a 64-bit integer sysctl.
    unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        );
    }
    value
}

pub struct Machine {
    pub cpu: String,
    pub model: String,
    pub cores: u64,
    pub memory_gb: u64,
    pub os: String,
}

pub fn machine() -> Machine {
    Machine {
        cpu: sysctl_string("machdep.cpu.brand_string"),
        model: sysctl_string("hw.model"),
        cores: sysctl_u64("hw.ncpu"),
        memory_gb: sysctl_u64("hw.memsize") / (1 << 30),
        os: sysctl_string("kern.osproductversion"),
    }
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

/// Draw right after an edit instead of on the next display-link tick. Off by
/// default (stock GPUI timing); `PROSE_SPIKE_PRESENT_NOW=1` or the bench's
/// comparison run turns it on.
pub static IMMEDIATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The editor's platform hooks on macOS.
pub struct MacHooks;

impl prose_spike::editor::PlatformHooks for MacHooks {
    fn present_now(&self, window: &gpui::Window) {
        if !IMMEDIATE.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
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

/// The current keyboard input source, and switching between enabled ones (what
/// Ctrl-Space does). Used by the real-IME checks; nothing is enabled or
/// installed.
#[cfg(target_os = "macos")]
pub mod input_source {
    use std::ffi::{CString, c_void};

    type CFTypeRef = *const c_void;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        static kTISPropertyInputSourceID: CFTypeRef;
        fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
        fn TISGetInputSourceProperty(source: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn TISCreateInputSourceList(properties: CFTypeRef, include_all: u8) -> CFTypeRef;
        fn TISSelectInputSource(source: CFTypeRef) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const i8, encoding: u32) -> CFTypeRef;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut i8, len: isize, encoding: u32) -> u8;
        fn CFDictionaryCreate(
            alloc: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFTypeRef;
        fn CFArrayGetCount(array: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFRelease(value: CFTypeRef);
    }

    const UTF8: u32 = 0x0800_0100;

    pub fn current() -> String {
        // SAFETY: Carbon/CF calls with owned references released afterwards.
        unsafe {
            let source = TISCopyCurrentKeyboardInputSource();
            if source.is_null() {
                return String::new();
            }
            let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
            let mut buf = [0i8; 256];
            let ok = !id.is_null() && CFStringGetCString(id, buf.as_mut_ptr(), 256, UTF8) != 0;
            CFRelease(source);
            if !ok {
                return String::new();
            }
            std::ffi::CStr::from_ptr(buf.as_ptr())
                .to_string_lossy()
                .into_owned()
        }
    }

    /// Selects an enabled input source by id. Returns false if none matched.
    pub fn select(id: &str) -> bool {
        let id = CString::new(id).unwrap();
        // SAFETY: as above.
        unsafe {
            let value = CFStringCreateWithCString(std::ptr::null(), id.as_ptr(), UTF8);
            let key = kTISPropertyInputSourceID;
            let filter = CFDictionaryCreate(
                std::ptr::null(),
                &key,
                &value,
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            let list = TISCreateInputSourceList(filter, 0);
            let mut ok = false;
            if !list.is_null() {
                if CFArrayGetCount(list) > 0 {
                    ok = TISSelectInputSource(CFArrayGetValueAtIndex(list, 0)) == 0;
                }
                CFRelease(list);
            }
            CFRelease(filter);
            CFRelease(value);
            ok
        }
    }
}
