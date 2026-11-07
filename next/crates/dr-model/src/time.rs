//! Time values stored in the book document.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Seconds since the Unix epoch (`deleted_at`, `created_at`, …). The book
/// document stores seconds, like Loro's own commit timestamps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(pub i64);

impl Timestamp {
    pub fn now() -> Self {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Timestamp(secs)
    }

    pub fn secs(self) -> i64 {
        self.0
    }
}

/// A calendar date `YYYY-MM-DD` in the writing device's own calendar.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Day(String);

impl Day {
    /// `None` unless `s` is a valid `YYYY-MM-DD` date (Gregorian, leap years
    /// included).
    pub fn parse(s: &str) -> Option<Self> {
        let b = s.as_bytes();
        if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
            return None;
        }
        let num = |r: std::ops::Range<usize>| -> Option<u32> {
            let part = &s[r];
            part.bytes()
                .all(|c| c.is_ascii_digit())
                .then(|| part.parse().ok())
                .flatten()
        };
        let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let days = match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => return None,
        };
        (1..=days).contains(&d).then(|| Day(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Day {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Day({})", self.0)
    }
}

impl TryFrom<String> for Day {
    type Error = String;
    fn try_from(s: String) -> Result<Self, String> {
        Day::parse(&s).ok_or_else(|| format!("not a YYYY-MM-DD date: {s:?}"))
    }
}

impl From<Day> for String {
    fn from(d: Day) -> String {
        d.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_validate() {
        assert!(Day::parse("2026-11-07").is_some());
        assert!(Day::parse("2024-02-29").is_some());
        assert!(Day::parse("2026-02-29").is_none());
        assert!(Day::parse("1900-02-29").is_none());
        assert!(Day::parse("2000-02-29").is_some());
        assert!(Day::parse("2026-1-07").is_none());
        assert!(Day::parse("2026-11-31").is_none());
        assert!(Day::parse("2026-00-01").is_none());
        assert!(Day::parse("+026-11-07").is_none());
    }
}
