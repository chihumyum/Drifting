//! The operating system's id for this machine: on macOS the hardware UUID
//! (`IOPlatformUUID`, read with `gethostuuid`), on Windows the `MachineGuid`
//! the system writes at installation (`HKLM\SOFTWARE\Microsoft\Cryptography`).
//! Other platforms have none here.
//!
//! Only the standard library is used, so this file can be type-checked on its
//! own for another target:
//!
//! ```text
//! rustc --edition 2024 --crate-type lib --target x86_64-pc-windows-msvc \
//!     --emit=metadata -o /tmp/machine.rmeta crates/dr-store/src/machine.rs
//! ```
//!
//! The raw id is not stored anywhere: [`crate::identity`] keeps a salted
//! digest of it.

/// The raw machine id, if the platform has one and it can be read.
pub fn platform_machine_id() -> Option<String> {
    imp::read()
}

#[cfg(target_os = "macos")]
mod imp {
    #[repr(C)]
    struct Timespec {
        tv_sec: i64,
        tv_nsec: i64,
    }

    unsafe extern "C" {
        /// `int gethostuuid(uuid_t id, const struct timespec *wait)` (libSystem):
        /// the host's hardware UUID, the same value as `IOPlatformUUID`.
        fn gethostuuid(id: *mut u8, wait: *const Timespec) -> i32;
    }

    pub fn read() -> Option<String> {
        let mut id = [0u8; 16];
        let wait = Timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        // SAFETY: `id` is the 16-byte uuid_t the call fills; `wait` is a valid
        // timespec that outlives the call.
        if unsafe { gethostuuid(id.as_mut_ptr(), &wait) } != 0 || id == [0u8; 16] {
            return None;
        }
        // IOPlatformUUID's own spelling: upper-case 8-4-4-4-12.
        let hex: String = id.iter().map(|b| format!("{b:02X}")).collect();
        Some(format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        ))
    }
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;

    const ERROR_SUCCESS: i32 = 0;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    /// Read the 64-bit registry view even from a 32-bit process.
    const RRF_SUBKEY_WOW6464KEY: u32 = 0x0001_0000;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            hkey: *mut c_void,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            data_len: *mut u32,
        ) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read() -> Option<String> {
        // HKEY_LOCAL_MACHINE is ((HKEY)(ULONG_PTR)((LONG)0x80000002)): the
        // 32-bit value sign-extended to pointer width.
        let hklm = (0x8000_0002_u32 as i32) as isize as *mut c_void;
        let sub_key = wide(r"SOFTWARE\Microsoft\Cryptography");
        let value = wide("MachineGuid");
        let mut buffer = [0u16; 128];
        let mut len = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: the key and value names are NUL-terminated UTF-16 strings,
        // `buffer` has `len` writable bytes, and every pointer outlives the call.
        let status = unsafe {
            RegGetValueW(
                hklm,
                sub_key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (len as usize / 2).min(buffer.len());
        let text = String::from_utf16(&buffer[..units]).ok()?;
        let text = text.trim_end_matches('\0').trim();
        (!text.is_empty()).then(|| text.to_string())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn read() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn this_machine_has_a_stable_id() {
        let a = super::platform_machine_id().expect("a machine id");
        assert_eq!(super::platform_machine_id().as_deref(), Some(a.as_str()));
        assert_eq!(a.len(), 36, "a GUID: {a}");
    }

    /// `gethostuuid` gives exactly what `ioreg` calls IOPlatformUUID.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_id_is_the_io_platform_uuid() {
        let out = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .expect("run ioreg");
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text
            .lines()
            .find(|l| l.contains("\"IOPlatformUUID\""))
            .expect("ioreg lists IOPlatformUUID");
        let uuid = line.rsplit('"').nth(1).expect("quoted value");
        assert_eq!(super::platform_machine_id().as_deref(), Some(uuid));
    }
}
