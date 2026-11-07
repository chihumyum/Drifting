//! What Project Home reads besides the book's lists (which the shell
//! already holds as `dr_shell::book::Book`), all through F3 off the main
//! thread:
//!
//! - the book's summary and word targets (`book.get`);
//! - each chapter's words and last change (`chapter.list`);
//! - today's words and the streak (`book.writing_days`);
//! - the pages opened last on this device (`recent.list`), for 继续写;
//! - the day the book was made, from a copy of the book document (F3 gives
//!   no `created_at` for one book; m02-home.md, 「待协调」).

use std::collections::HashMap;

use chrono::NaiveDate;
use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{
        BookIn, ListIn,
        book::BookGet,
        chapter::ChapterList,
        recent::{RecentList, RecentListIn},
        stats::{WritingDays, WritingDaysIn},
    },
};

/// A page the author opened recently on this device (the kinds 继续写
/// shows: a chapter or an idea, or an element).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub page: Page,
    /// When, ms since the epoch.
    pub used_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Page {
    /// A chapter or an idea (F3's `node`).
    Node(String),
    Element(String),
}

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
    /// Last change by chapter id, ms since the epoch.
    pub chapter_edited: HashMap<String, i64>,
    /// Words written today, every device together.
    pub today: i64,
    /// Days in a row with words, ending today (0 when today has none).
    pub streak: u32,
    /// Opened last first, chapters, ideas and elements only.
    pub opened: Vec<Opened>,
    /// The words and last change of the ideas in `opened` (chapters have
    /// theirs above).
    pub idea_words: HashMap<String, u64>,
    pub idea_edited: HashMap<String, i64>,
}

impl HomeStats {
    /// Reads `book`'s numbers; `today` is the device's calendar day. Call
    /// it off the main thread.
    pub fn load(lib: &Library, book: &str, today: NaiveDate) -> Result<HomeStats, WsError> {
        let me = &Actor::User;
        let detail = lib
            .run::<BookGet>(
                me,
                BookIn {
                    book: book.to_owned(),
                },
            )?
            .output;
        let chapters = lib
            .run::<ChapterList>(
                me,
                ListIn {
                    book: book.to_owned(),
                    trashed: false,
                },
            )?
            .output;
        let days = lib
            .run::<WritingDays>(
                me,
                WritingDaysIn {
                    book: book.to_owned(),
                    today: today.format("%Y-%m-%d").to_string(),
                    days: Some(1),
                    device: None,
                },
            )?
            .output;
        let recent = lib
            .run::<RecentList>(
                me,
                RecentListIn {
                    book: book.to_owned(),
                    limit: None,
                },
            )?
            .output;
        let mut stats = HomeStats {
            book: book.to_owned(),
            summary: detail.info.summary,
            word_target: detail.info.word_target,
            daily_target: detail.info.daily_word_target,
            created: created(lib, book),
            today: days.today,
            streak: days.streak,
            ..HomeStats::default()
        };
        for c in &chapters {
            stats.words += c.words;
            stats.chapter_words.insert(c.id.clone(), c.words);
            if let Some(at) = c.updated_at {
                stats.chapter_edited.insert(c.id.clone(), at * 1000);
            }
        }
        for entry in recent {
            let page = match entry.target.kind.as_str() {
                "node" => Page::Node(entry.target.id),
                "element" => Page::Element(entry.target.id),
                _ => continue,
            };
            if let Page::Node(id) = &page
                && !stats.chapter_words.contains_key(id)
            {
                let doc = format!("node:{id}");
                let store = lib.library();
                let words = store.doc_stats(&doc).ok().flatten().map_or(0, |s| s.words);
                stats.idea_words.insert(id.clone(), words);
                if let Some(head) = store.head(&doc).ok().flatten() {
                    stats.idea_edited.insert(id.clone(), head.ts);
                }
            }
            stats.opened.push(Opened {
                page,
                used_ms: entry.used_ms,
            });
        }
        Ok(stats)
    }
}

/// The day the book was made, from a copy of its book document.
fn created(lib: &Library, book: &str) -> Option<NaiveDate> {
    let id = dr_model::id::BookId::parse(book).ok()?;
    let doc = match lib.library().load_copy(&format!("book:{book}")) {
        Ok(doc) => doc,
        Err(error) => {
            log::warn!("book {book}: its creation day not read: {error}");
            return None;
        }
    };
    let reader = dr_doc::book::BookReader::from_loro(id, &doc).ok()?;
    let at = reader.view().meta().created_at?;
    chrono::DateTime::from_timestamp(at.secs(), 0)
        .map(|t| t.with_timezone(&chrono::Local).date_naive())
}
