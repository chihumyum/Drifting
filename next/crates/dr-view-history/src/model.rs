//! What the history dialog shows, without GPUI: which kind a page is, and
//! how a point's time reads.

use chrono::{DateTime, Datelike, Local, TimeZone};
use dr_i18n::{Key, keys};

/// The 0.1 history's kind label of a prose document (`snapshotHistory.kind`).
pub fn kind_key(doc: &str) -> Option<Key> {
    use keys::snapshot_history::kind;
    Some(match doc.split_once(':')?.0 {
        "node" => kind::NODE,
        "element" => kind::ELEMENT,
        "storyline" => kind::STORYLINE,
        "category" => kind::CATEGORY,
        "material" => kind::LIBRARY_ITEM,
        _ => return None,
    })
}

/// A point's time as the 0.1 list wrote it, in the device's time zone:
/// `MM/DD HH:mm`, with `YYYY/` in front outside the current year.
pub fn stamp(ts_ms: i64, now_ms: i64) -> String {
    stamp_in(&Local, ts_ms, now_ms)
}

/// [`stamp`] in a given time zone (tests).
pub fn stamp_in<Tz: TimeZone>(tz: &Tz, ts_ms: i64, now_ms: i64) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let at = |ms: i64| -> Option<DateTime<Tz>> { tz.timestamp_millis_opt(ms).single() };
    let (Some(t), Some(now)) = (at(ts_ms), at(now_ms)) else {
        return String::new();
    };
    if t.year() == now.year() {
        t.format("%m/%d %H:%M").to_string()
    } else {
        t.format("%Y/%m/%d %H:%M").to_string()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Utc};

    #[test]
    fn kinds_by_document() {
        assert_eq!(kind_key("node:x"), Some(keys::snapshot_history::kind::NODE));
        assert_eq!(
            kind_key("material:x"),
            Some(keys::snapshot_history::kind::LIBRARY_ITEM)
        );
        assert_eq!(kind_key("book:x"), None);
        assert_eq!(kind_key("nonsense"), None);
    }

    #[test]
    fn stamps_add_the_year_only_outside_this_one() {
        let utc = Utc;
        // 2026-11-08 09:05 UTC and 2025-12-31 23:59 UTC.
        let now = 1_794_128_700_000;
        let last_year = 1_767_225_540_000;
        assert_eq!(stamp_in(&utc, now, now), "11/08 09:05");
        assert_eq!(stamp_in(&utc, last_year, now), "2025/12/31 23:59");
        // The device's own time zone decides the day.
        let east = FixedOffset::east_opt(8 * 3600).unwrap();
        assert_eq!(stamp_in(&east, last_year, now), "01/01 07:59");
    }
}
