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

/// A moment (Unix seconds) on the local clock: year, month, day, hour,
/// minute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Local {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

/// `secs` (Unix seconds) on the local clock.
pub fn local(secs: i64) -> Local {
    let offset = utc_offset(secs);
    let t = secs + offset;
    let days = t.div_euclid(86_400);
    let rest = t.rem_euclid(86_400);
    let date = dr_workspace::commands::stats::day_of_number(days);
    let (y, m, d) = (
        date.as_str()[..4].parse().unwrap_or(1970),
        date.as_str()[5..7].parse().unwrap_or(1),
        date.as_str()[8..].parse().unwrap_or(1),
    );
    Local {
        year: y,
        month: m,
        day: d,
        hour: (rest / 3600) as u32,
        minute: (rest % 3600 / 60) as u32,
    }
}

/// The local clock's offset from UTC at `secs`, in seconds.
#[cfg(unix)]
fn utc_offset(secs: i64) -> i64 {
    // SAFETY: `localtime_r` writes into the `tm` we own.
    unsafe {
        let t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return 0;
        }
        tm.tm_gmtoff as i64
    }
}

/// The local clock's offset from UTC now (daylight saving as it is today).
#[cfg(windows)]
fn utc_offset(_secs: i64) -> i64 {
    use windows::Win32::System::SystemInformation::{GetLocalTime, GetSystemTime};
    // SAFETY: both only fill the struct they return.
    let (l, u) = unsafe { (GetLocalTime(), GetSystemTime()) };
    let mut d = (i64::from(l.wHour) * 60 + i64::from(l.wMinute))
        - (i64::from(u.wHour) * 60 + i64::from(u.wMinute));
    if l.wDay != u.wDay {
        // Local time is a day ahead of UTC (or behind it), a month's end
        // included.
        let ahead = l.wDay == u.wDay + 1 || (l.wDay == 1 && u.wDay >= 28);
        d += if ahead { 1440 } else { -1440 };
    }
    d * 60
}

#[cfg(not(any(unix, windows)))]
fn utc_offset(_secs: i64) -> i64 {
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_moment_reads_on_the_local_clock() {
        let l = super::local(1_762_560_000);
        assert!((2025..=2026).contains(&l.year), "{l:?}");
        assert!(l.hour < 24 && l.minute < 60);
    }

    #[test]
    fn today_is_a_date() {
        let d = super::today();
        assert_eq!(d.as_str().len(), 10);
        assert!(d.as_str() >= "2026-01-01", "{d}");
    }
}
