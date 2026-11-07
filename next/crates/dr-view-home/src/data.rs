//! What Project Home reads besides the book's lists (which the shell
//! already holds as `dr_shell::book::Book`): the book's summary and word
//! targets (`book.get`), each chapter's words and last edit (the derived
//! index and the stored heads, as the bookshelf reads them), and today's
//! words and the streak from the book's writing days.

use std::collections::HashMap;

use chrono::NaiveDate;
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{BookIn, book::BookGet},
};

/// Project Home's numbers for one book.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HomeStats {
    pub book: String,
    pub summary: String,
    /// `None`: turned off.
    pub word_target: Option<i64>,
    pub daily_target: Option<i64>,
    /// When the book was made, if it says.
    pub created: Option<NaiveDate>,
    /// The live chapters' words.
    pub words: u64,
    /// Words by chapter id.
    pub chapter_words: HashMap<String, u64>,
    /// Last edit by chapter id, ms since the epoch.
    pub chapter_edited: HashMap<String, i64>,
    /// Words written today, every device together.
    pub today: i64,
    /// Days in a row with words, ending today (0 when today has none).
    pub streak: u32,
}

impl HomeStats {
    /// Reads `book`'s numbers. `chapters` are its live chapters' ids;
    /// `today` is the device's calendar day. Call it off the main thread.
    pub fn load(
        lib: &Library,
        book: &str,
        chapters: &[String],
        today: NaiveDate,
    ) -> Result<HomeStats, WsError> {
        let detail = lib
            .run::<BookGet>(
                &Actor::User,
                BookIn {
                    book: book.to_owned(),
                },
            )?
            .output;
        let mut chapter_words = HashMap::new();
        let mut chapter_edited = HashMap::new();
        for id in chapters {
            let doc = format!("node:{id}");
            chapter_words.insert(
                id.clone(),
                dr_view_shelf::data::words_of(lib, std::slice::from_ref(&doc)),
            );
            if let Some(at) = dr_view_shelf::data::doc_edited_ms(lib, &doc) {
                chapter_edited.insert(id.clone(), at);
            }
        }
        let (days, created) = book_days(lib, book);
        let (today_words, streak) = today_and_streak(&days, today);
        Ok(HomeStats {
            book: book.to_owned(),
            summary: detail.info.summary,
            word_target: detail.info.word_target,
            daily_target: detail.info.daily_word_target,
            created,
            words: chapter_words.values().sum(),
            chapter_words,
            chapter_edited,
            today: today_words,
            streak,
        })
    }
}

/// The book's writing days (words by day, every device together) and the
/// day it was made, read from a copy of its book document (F3 has no
/// query for them yet; see m02-home.md, 「待协调」).
fn book_days(lib: &Library, book: &str) -> (HashMap<NaiveDate, i64>, Option<NaiveDate>) {
    let mut days = HashMap::new();
    let Ok(id) = dr_model::id::BookId::parse(book) else {
        return (days, None);
    };
    let doc = match lib.library().load_copy(&format!("book:{book}")) {
        Ok(doc) => doc,
        Err(error) => {
            log::warn!("book {book}: writing days not read: {error}");
            return (days, None);
        }
    };
    let Ok(reader) = dr_doc::book::BookReader::from_loro(id, &doc) else {
        return (days, None);
    };
    let view = reader.view();
    for w in view.writing_days() {
        if let Ok(day) = NaiveDate::parse_from_str(w.day.as_str(), "%Y-%m-%d") {
            *days.entry(day).or_insert(0) += w.words;
        }
    }
    let created = view
        .meta()
        .created_at
        .and_then(|t| chrono::DateTime::from_timestamp(t.secs(), 0))
        .map(|t| t.with_timezone(&chrono::Local).date_naive());
    (days, created)
}

/// Today's words and the streak ending today (the stats panel's rule: a
/// day without words today means a streak of 0).
pub fn today_and_streak(days: &HashMap<NaiveDate, i64>, today: NaiveDate) -> (i64, u32) {
    let words = |d: NaiveDate| days.get(&d).copied().unwrap_or(0);
    let mut streak = 0;
    let mut day = today;
    while words(day) > 0 {
        streak += 1;
        match day.pred_opt() {
            Some(d) => day = d,
            None => break,
        }
    }
    (words(today), streak)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn the_streak_ends_today() {
        let mut days = HashMap::new();
        days.insert(day("2026-11-06"), 300);
        days.insert(day("2026-11-07"), 500);
        days.insert(day("2026-11-08"), 120);
        days.insert(day("2026-11-04"), 900);
        assert_eq!(today_and_streak(&days, day("2026-11-08")), (120, 3));
        // Nothing written today yet: no streak, as the stats panel says.
        assert_eq!(today_and_streak(&days, day("2026-11-09")), (0, 0));
        assert_eq!(today_and_streak(&days, day("2026-11-04")), (900, 1));
    }
}
