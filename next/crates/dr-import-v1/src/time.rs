//! The 0.1 client stored times as ISO-8601 text (`2026-11-07T10:55:36.848Z`,
//! JavaScript's `toISOString`); a few rows written by SQLite defaults use
//! `2026-11-07 10:55:36`. Schema v2 stores seconds, dr-store milliseconds.

use dr_model::Timestamp;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(s: &[u8], at: usize, n: usize) -> Option<i64> {
    let part = s.get(at..at + n)?;
    if !part.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(part).ok()?.parse().ok()
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// Unix milliseconds of an ISO-8601 date-time (`T` or space separated,
/// optional fraction, `Z`, `±HH:MM` or no zone meaning UTC). `None` for
/// anything else.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    let y = digits(b, 0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let mo = digits(b, 5, 2)?;
    let d = digits(b, 8, 2)?;
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) {
        return None;
    }
    let mut ms = days_from_civil(y, mo, d) * 86_400_000;
    if b.len() == 10 {
        return Some(ms);
    }
    if !matches!(b.get(10), Some(b'T' | b't' | b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let h = digits(b, 11, 2)?;
    let mi = digits(b, 14, 2)?;
    let mut at = 16;
    let mut sec = 0;
    if b.get(16) == Some(&b':') {
        sec = digits(b, 17, 2)?;
        at = 19;
    }
    if h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    ms += (h * 3600 + mi * 60 + sec) * 1000;
    if b.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
        // Milliseconds: the first three digits, padded.
        let frac = &s.trim()[start..at];
        let mut three: String = frac.chars().take(3).collect();
        while three.len() < 3 {
            three.push('0');
        }
        ms += three.parse::<i64>().ok()?;
    }
    match b.get(at) {
        None => Some(ms),
        Some(b'Z' | b'z') if at + 1 == b.len() => Some(ms),
        Some(sign @ (b'+' | b'-')) => {
            let oh = digits(b, at + 1, 2)?;
            let om = if b.get(at + 3) == Some(&b':') {
                digits(b, at + 4, 2)?
            } else {
                digits(b, at + 3, 2)?
            };
            let offset = (oh * 60 + om) * 60_000;
            Some(if *sign == b'+' {
                ms - offset
            } else {
                ms + offset
            })
        }
        _ => None,
    }
}

/// Seconds (schema v2's [`Timestamp`]) of an ISO-8601 date-time.
pub fn parse_iso(s: &str) -> Option<Timestamp> {
    parse_iso_ms(s).map(|ms| Timestamp(ms.div_euclid(1000)))
}

/// [`parse_iso`] of an optional column.
pub fn parse_opt(s: Option<&str>) -> Option<Timestamp> {
    s.and_then(parse_iso)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_iso_strings() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-11-07T10:55:36.848Z"),
            Some(1_794_048_936_848)
        );
        assert_eq!(
            parse_iso("2026-11-07T10:55:36.848Z"),
            Some(Timestamp(1_794_048_936))
        );
        // Leap day, before the epoch, offsets and SQLite's own format.
        assert_eq!(
            parse_iso_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        assert_eq!(parse_iso_ms("1969-12-31T23:59:59.999Z"), Some(-1));
        assert_eq!(
            parse_iso_ms("2026-11-07T18:55:36.848+08:00"),
            parse_iso_ms("2026-11-07T10:55:36.848Z")
        );
        assert_eq!(parse_iso_ms("2026-11-07 10:55:36"), Some(1_794_048_936_000));
        assert_eq!(parse_iso_ms("2026-11-07"), Some(1_794_009_600_000));
        assert_eq!(
            parse_iso_ms("2026-11-07T10:55:36.8Z"),
            Some(1_794_048_936_800)
        );
    }

    #[test]
    fn rejects_what_is_not_a_date() {
        for bad in [
            "",
            "yesterday",
            "2026-02-30T00:00:00Z",
            "2025-02-29",
            "2026-13-01",
            "2026-11-07T25:00:00Z",
            "2026-11-07T10:55:36.Z",
            "2026-11-07T10:55:36Zjunk",
        ] {
            assert_eq!(parse_iso_ms(bad), None, "{bad}");
        }
    }
}
