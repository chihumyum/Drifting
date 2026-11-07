//! Word counts and writing days (M07, docs/rust-rewrite/modules/m07-words.md).
//!
//! - `book.word_counts`: each live chapter's and idea's words from the
//!   derived index, each storyline's (its chapters'), the book's (its live
//!   chapters', as the 0.1 client counted it) and the word targets. A
//!   document the index has not counted yet says so (`counted: false`).
//! - `book.writing_days`: words written per day, summed over devices; today,
//!   the last seven days, active days of the last thirty and the streak, by
//!   the 0.1 client's in-book rules (`deriveWritingStats`).
//! - `writing_day.record`: one device's words for one day (the recorder in
//!   `dr-view-stats` calls it; each device writes only its own key).

use std::collections::BTreeMap;

use dr_model::Day;
use dr_model::id::DeviceKey;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::*;
use crate::registry::Registry;

pub(crate) fn register(r: &mut Registry) {
    r.add::<WordCounts>()
        .add::<WritingDays>()
        .add::<WritingDayRecord>();
}

/// Words and characters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Count {
    pub words: u64,
    pub chars: u64,
}

impl std::ops::AddAssign for Count {
    fn add_assign(&mut self, o: Count) {
        self.words += o.words;
        self.chars += o.chars;
    }
}

/// One prose document's count.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct DocCount {
    /// The chapter's or idea's id.
    pub id: String,
    /// Its prose document.
    pub doc: String,
    #[serde(flatten)]
    pub count: Count,
    /// The derived index has counted it (false: still counting; the count
    /// is 0 then).
    pub counted: bool,
    /// A chapter's storylines.
    pub storylines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct StorylineCount {
    pub id: String,
    /// Its live chapters'.
    #[serde(flatten)]
    pub count: Count,
    pub chapters: u32,
    /// Every one of its chapters is counted.
    pub counted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct WordCountsOut {
    /// Live chapters, in reading order.
    pub chapters: Vec<DocCount>,
    /// Live ideas (构想).
    pub ideas: Vec<DocCount>,
    /// Live storylines, in their order.
    pub storylines: Vec<StorylineCount>,
    /// The book: its live chapters.
    pub book: Count,
    /// Every chapter is counted.
    pub counted: bool,
    /// The book's word target (`None`: turned off).
    pub word_target: Option<i64>,
    /// Words per day (`None`: turned off).
    pub daily_word_target: Option<i64>,
}

op! {
    WordCounts = "book.word_counts", Read, Shared,
    "Word counts of a book from the derived index: each chapter, idea and storyline, the book (its chapters), and the word targets.",
    fn(cx, input: BookIn) -> WordCountsOut {
        let slot = cx.book(&input.book)?;
        let lib = cx.workspace().library();
        let count = |n: &dr_model::book::Node| -> Result<DocCount> {
            let doc = format!("node:{}", n.id);
            let stats = lib.doc_stats(&doc)?;
            Ok(DocCount {
                id: n.id.to_string(),
                count: stats.as_ref().map(|s| Count { words: s.words, chars: s.chars }).unwrap_or_default(),
                counted: stats.is_some(),
                doc,
                storylines: if n.is_chapter() { n.storylines.iter().map(|s| s.to_string()).collect() } else { Vec::new() },
            })
        };
        let chapters_in_order = chapters(&slot);
        let chapters: Vec<DocCount> = chapters_in_order.iter().map(count).collect::<Result<_>>()?;
        let mut ideas: Vec<_> = nodes(&slot).values().filter(|n| n.is_drift() && !n.is_trashed()).cloned().collect();
        ideas.sort_by(|a, b| a.title.cmp(&b.title).then(a.id.cmp(&b.id)));
        let ideas: Vec<DocCount> = ideas.iter().map(count).collect::<Result<_>>()?;
        let mut book = Count::default();
        for c in &chapters {
            book += c.count;
        }
        let mut lines: Vec<_> = storylines(&slot).iter().filter(|s| s.deleted_at.is_none()).cloned().collect();
        lines.sort_by(|a, b| dr_model::pos::cmp_pos((a.pos.as_ref(), &a.id), (b.pos.as_ref(), &b.id)));
        let storylines = lines.iter().map(|s| {
            let mut total = Count::default();
            let (mut n, mut counted) = (0u32, true);
            for c in &chapters {
                if c.storylines.iter().any(|x| x == s.id.as_str()) {
                    total += c.count;
                    n += 1;
                    counted &= c.counted;
                }
            }
            StorylineCount { id: s.id.to_string(), count: total, chapters: n, counted }
        }).collect();
        let m = meta(&slot);
        Ok(WordCountsOut {
            counted: chapters.iter().all(|c| c.counted),
            chapters, ideas, storylines, book,
            word_target: m.word_target(),
            daily_word_target: m.daily_word_target(),
        })
    }
}

// ---- writing days -------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WritingDaysIn {
    pub book: String,
    /// Today in the writer's own calendar, `YYYY-MM-DD`.
    pub today: String,
    /// How many days to list, ending today (default 7, at most 400).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<u32>,
    /// This device's writing-day key: its own words for today are returned
    /// too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct DayWords {
    pub day: String,
    pub words: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct WritingDaysOut {
    /// The days asked for, oldest first, every day listed (0 when nothing
    /// was written), summed over devices.
    pub days: Vec<DayWords>,
    pub today: i64,
    /// `device`'s own words today (0 without one).
    pub mine_today: i64,
    /// The last seven days, today included.
    pub week: i64,
    /// Days with words among the last thirty, today included.
    pub active_days: u32,
    /// Consecutive days with words, ending today (0 when today has none).
    pub streak: u32,
    /// Consecutive days with words, ending yesterday (the streak today's
    /// first words continue).
    pub streak_before: u32,
    pub daily_word_target: Option<i64>,
}

/// Days since 1970-01-01 of a valid date (Howard Hinnant's algorithm).
pub fn day_number(day: &Day) -> i64 {
    let s = day.as_str();
    let (y, m, d): (i64, i64, i64) = (
        s[0..4].parse().unwrap_or(1970),
        s[5..7].parse().unwrap_or(1),
        s[8..10].parse().unwrap_or(1),
    );
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `n` days after 1970-01-01.
pub fn day_of_number(n: i64) -> Day {
    let z = n + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Day::parse(&format!("{y:04}-{m:02}-{d:02}")).expect("a computed date is valid")
}

/// The 0.1 client's in-book writing stats over days summed across devices
/// (`deriveWritingStats`): (week, active days of thirty, the streak ending
/// yesterday). The streak ending today is one more than the last when today
/// has words, else 0.
pub fn summarize(by_day: &BTreeMap<i64, i64>, today: i64) -> (i64, u32, u32) {
    let words = |n: i64| by_day.get(&n).copied().unwrap_or(0);
    let week = (0..7).map(|i| words(today - i)).sum();
    let active = (0..30).filter(|i| words(today - i) > 0).count() as u32;
    let mut before = 0;
    while before < 365 && words(today - 1 - i64::from(before)) > 0 {
        before += 1;
    }
    (week, active, before)
}

fn day_in(s: &str) -> Result<Day> {
    Day::parse(s).ok_or_else(|| WsError::invalid(format!("{s:?} is not a YYYY-MM-DD date")))
}

fn device_in(s: &str) -> Result<DeviceKey> {
    DeviceKey::parse(s)
        .map_err(|_| WsError::invalid(format!("{s:?} is not a writing-day device key")))
}

op! {
    WritingDays = "book.writing_days", Read, Shared,
    "A book's writing days: words written per day (all devices), today, the last seven days, active days and the streak.",
    fn(cx, input: WritingDaysIn) -> WritingDaysOut {
        let slot = cx.book(&input.book)?;
        let today = day_number(&day_in(&input.today)?);
        let device = input.device.as_deref().map(device_in).transpose()?;
        let mut by_day: BTreeMap<i64, i64> = BTreeMap::new();
        let mut mine_today = 0;
        for w in slot.reader.view().writing_days() {
            let n = day_number(&w.day);
            *by_day.entry(n).or_default() += w.words;
            if n == today && device.as_ref() == Some(&w.device) {
                mine_today = w.words;
            }
        }
        let span = i64::from(input.days.unwrap_or(7).clamp(1, 400));
        let days = (today - span + 1..=today)
            .map(|n| DayWords { day: day_of_number(n).to_string(), words: by_day.get(&n).copied().unwrap_or(0) })
            .collect();
        let (week, active_days, streak_before) = summarize(&by_day, today);
        let words_today = by_day.get(&today).copied().unwrap_or(0);
        Ok(WritingDaysOut {
            days,
            today: words_today,
            streak: if words_today > 0 { streak_before + 1 } else { 0 },
            mine_today, week, active_days, streak_before,
            daily_word_target: meta(&slot).daily_word_target(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct WritingDayIn {
    pub book: String,
    /// This device's writing-day key (`device-` and 24 hex digits).
    pub device: String,
    /// `YYYY-MM-DD` in this device's calendar.
    pub day: String,
    /// Words this device added to the book that day (0 or more).
    pub words: i64,
}

op! {
    WritingDayRecord = "writing_day.record", Write, Book,
    "Set this device's words for one day of a book (the writing-day recorder; not undoable).",
    fn(cx, input: WritingDayIn) -> Done {
        let slot = cx.book(&input.book)?;
        let device = device_in(&input.device)?;
        let day = day_in(&input.day)?;
        if input.words < 0 {
            return Err(WsError::invalid("words cannot be negative"));
        }
        let key = dr_model::book::WritingDay::key(&device, &day);
        let same = slot.reader.view().writing_days().iter()
            .any(|w| w.device == device && w.day == day && w.words == input.words);
        if !same {
            let words = input.words;
            cx.write_book(&slot, move |txn| { txn.writing_day(&device, &day, words)?; Ok(()) })?;
        }
        // No effect and no inverse: the recorder's writes leave no journal
        // row, so they never sit between the author and their undo.
        cx.irreversible();
        Ok(Done { id: key })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_numbers_round_trip() {
        for s in [
            "1970-01-01",
            "2000-02-29",
            "2026-11-08",
            "2024-12-31",
            "1969-12-31",
        ] {
            let d = Day::parse(s).unwrap();
            assert_eq!(day_of_number(day_number(&d)), d, "{s}");
        }
        assert_eq!(day_number(&Day::parse("1970-01-02").unwrap()), 1);
        let a = day_number(&Day::parse("2026-02-28").unwrap());
        assert_eq!(day_of_number(a + 1).as_str(), "2026-03-01");
    }

    #[test]
    fn the_streak_ends_today() {
        let mut by_day = BTreeMap::new();
        for (n, w) in [(10, 5), (9, 1), (8, 0), (7, 3), (3, 2)] {
            by_day.insert(n, w);
        }
        // Today (10) has words: the streak is yesterday's run plus one.
        assert_eq!(summarize(&by_day, 10), (9, 4, 1));
        // Nothing yet on day 11: yesterday's run is still there to continue.
        assert_eq!(summarize(&by_day, 11).2, 2);
        assert_eq!(summarize(&by_day, 12).2, 0);
    }
}
