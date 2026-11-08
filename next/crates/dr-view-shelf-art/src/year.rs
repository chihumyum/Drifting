//! The library's year of writing days (the 0.1 client's `WritingYear` and
//! its readings in `store/writing-stats-store.ts`, docs/writing-days.md):
//! every day from the Monday 52 weeks before this week's through today,
//! the words of every book together and of each book, from F3's
//! `book.writing_days` (all devices summed).

use std::collections::HashMap;

use dr_workspace::{Actor, Workspace};
use serde_json::json;

use crate::format::{day_number, day_of_number, weekday};

/// The heat map's weeks.
pub const WEEKS: usize = 53;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WritingYear {
    /// Every day from the first Monday through today, `YYYY-MM-DD`.
    pub days: Vec<String>,
    /// Words on each of `days`, every book together.
    pub total: Vec<u64>,
    /// Words on each of `days`, per book that has any.
    pub by_book: HashMap<String, Vec<u64>>,
}

/// The Monday that starts the heat map whose last week holds `today`.
pub fn year_start(today: &str) -> String {
    day_of_number(day_number(today) - weekday(today) as i64 - (WEEKS as i64 - 1) * 7)
}

impl WritingYear {
    /// The days of the year ending `today`, nothing written yet.
    pub fn empty(today: &str) -> WritingYear {
        let (first, last) = (day_number(&year_start(today)), day_number(today));
        let days: Vec<String> = (first..=last).map(day_of_number).collect();
        WritingYear {
            total: vec![0; days.len()],
            days,
            by_book: HashMap::new(),
        }
    }

    /// Adds `book`'s words for each of `days` (`YYYY-MM-DD`); days outside
    /// the year are left out.
    pub fn add(&mut self, book: &str, days: impl IntoIterator<Item = (String, u64)>) {
        let first = self.days.first().map_or(0, |d| day_number(d));
        let len = self.days.len();
        for (day, words) in days {
            if words == 0 {
                continue;
            }
            let i = day_number(&day) - first;
            if i < 0 || i as usize >= len {
                continue;
            }
            let i = i as usize;
            self.by_book
                .entry(book.to_owned())
                .or_insert_with(|| vec![0; len])[i] += words;
            self.total[i] += words;
        }
    }

    /// The year of `books` ending `today`, read from F3 (one
    /// `book.writing_days` each; run it off the main thread). A book that
    /// cannot be read counts as nothing written.
    pub fn load(ws: &Workspace, books: &[String], today: &str) -> WritingYear {
        let mut year = WritingYear::empty(today);
        let span = year.days.len();
        for book in books {
            let out = ws.call(
                &Actor::User,
                "book.writing_days",
                json!({ "book": book, "today": today, "days": span }),
            );
            let Ok(out) = out else {
                continue;
            };
            let days = out["output"]["days"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|d| {
                    let words = d["words"].as_i64().unwrap_or(0).max(0) as u64;
                    Some((d["day"].as_str()?.to_owned(), words))
                });
            year.add(book, days.collect::<Vec<_>>());
        }
        year
    }

    /// The weeks shown (columns of the heat map).
    pub fn columns(&self) -> usize {
        self.days.len().div_ceil(7)
    }

    /// Words a day for `book`, or every book together.
    pub fn daily(&self, book: Option<&str>) -> Vec<u64> {
        match book {
            None => self.total.clone(),
            Some(b) => self
                .by_book
                .get(b)
                .cloned()
                .unwrap_or_else(|| vec![0; self.days.len()]),
        }
    }

    /// `book`'s last `n` days, today last (a card's strip).
    pub fn recent(&self, book: &str, n: usize) -> Vec<u64> {
        let daily = self.daily(Some(book));
        daily[daily.len().saturating_sub(n)..].to_vec()
    }
}

/// The year's readings beside the map.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub words: u64,
    pub days_written: usize,
    /// Consecutive days with words ending today.
    pub streak: usize,
    pub today: u64,
}

pub fn summarize(daily: &[u64]) -> Summary {
    Summary {
        words: daily.iter().sum(),
        days_written: daily.iter().filter(|&&w| w > 0).count(),
        streak: daily.iter().rev().take_while(|&&w| w > 0).count(),
        today: daily.last().copied().unwrap_or(0),
    }
}

/// Four levels from the quartiles of the days written, like a
/// contribution graph.
pub fn thresholds(daily: &[u64]) -> [u64; 3] {
    let mut written: Vec<u64> = daily.iter().copied().filter(|&w| w > 0).collect();
    written.sort_unstable();
    let at = |fraction: f64| {
        if written.is_empty() {
            return 1;
        }
        let i = ((fraction * written.len() as f64).floor() as usize).min(written.len() - 1);
        written[i]
    };
    [at(0.25), at(0.5), at(0.75)]
}

pub fn level(words: u64, thresholds: [u64; 3]) -> u8 {
    match words {
        0 => 0,
        w if w <= thresholds[0] => 1,
        w if w <= thresholds[1] => 2,
        w if w <= thresholds[2] => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_year_runs_from_a_monday_to_today() {
        // 2026-11-08 is a Sunday: 53 whole weeks.
        let year = WritingYear::empty("2026-11-08");
        assert_eq!(year.days.first().map(String::as_str), Some("2025-11-03"));
        assert_eq!(year.days.len(), 371);
        assert_eq!(weekday(&year.days[0]), 0);
        // A Wednesday: the last week has three days.
        let year = WritingYear::empty("2026-11-04");
        assert_eq!(year.days.len(), 367);
        assert_eq!(year.columns(), 53);
    }

    #[test]
    fn days_add_up_and_read_as_the_old_client_read_them() {
        let mut year = WritingYear::empty("2026-11-08");
        year.add(
            "a",
            [
                ("2026-11-08".to_owned(), 300),
                ("2026-11-07".to_owned(), 100),
                ("2020-01-01".to_owned(), 9),
            ],
        );
        year.add("b", [("2026-11-08".to_owned(), 50)]);
        assert_eq!(year.total.last(), Some(&350));
        assert_eq!(year.recent("a", 3), [0, 100, 300]);
        assert_eq!(year.daily(Some("none")).iter().sum::<u64>(), 0);
        let s = summarize(&year.total);
        assert_eq!(
            (s.words, s.days_written, s.streak, s.today),
            (450, 2, 2, 350)
        );
        let t = thresholds(&[0, 10, 20, 30, 40, 0]);
        assert_eq!(t, [20, 30, 40]);
        assert_eq!(
            [0, 10, 20, 25, 40, 41].map(|w| level(w, t)),
            [0, 1, 1, 2, 3, 4]
        );
    }
}
