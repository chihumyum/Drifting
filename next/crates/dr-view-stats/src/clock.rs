//! Today's date in the writer's own calendar (writing days are kept by the
//! device's local date, as in the 0.1 client's `todayKey`).

use dr_model::Day;

/// The local calendar date now.
pub fn today() -> Day {
    let (y, m, d) = local_ymd();
    Day::parse(&format!("{y:04}-{m:02}-{d:02}")).unwrap_or_else(|| {
        // A clock this broken still writes somewhere sensible.
        Day::parse("1970-01-01").expect("a valid date")
    })
}

#[cfg(unix)]
fn local_ymd() -> (i32, u32, u32) {
    // SAFETY: `time` with a null pointer only returns the time;
    // `localtime_r` writes into the `tm` we own.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return (1970, 1, 1);
        }
        (tm.tm_year + 1900, (tm.tm_mon + 1) as u32, tm.tm_mday as u32)
    }
}

#[cfg(windows)]
fn local_ymd() -> (i32, u32, u32) {
    // SAFETY: GetLocalTime only fills the struct it returns.
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    (i32::from(t.wYear), u32::from(t.wMonth), u32::from(t.wDay))
}

#[cfg(not(any(unix, windows)))]
fn local_ymd() -> (i32, u32, u32) {
    (1970, 1, 1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn today_is_a_date() {
        let d = super::today();
        assert_eq!(d.as_str().len(), 10);
        assert!(d.as_str() >= "2026-01-01", "{d}");
    }
}
