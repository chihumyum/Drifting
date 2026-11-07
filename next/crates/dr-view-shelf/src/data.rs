//! What the bookshelf shows, read through F3 (`dr-workspace`) off the main
//! thread in one query (`book.shelf`): every book with its counts, words,
//! word target and last change, and the books in Recently Deleted with the
//! days they have left.
//!
//! - Words are the live chapters' words in the derived index, as the 0.1
//!   shelf counted them: only chapters, not ideas, elements or notes.
//! - The last change is the newest stored change of any of the book's
//!   documents; the book document holds no `updated_at`
//!   (simplifications.md, 第一节第 13 条).

use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::book::{BookShelf, ListBooksIn},
};

/// One book on the shelf.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShelfBook {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The 「副标题」 project fact, as the 0.1 shelf read it.
    pub subtitle: Option<String>,
    pub chapters: u32,
    pub storylines: u32,
    pub elements: u32,
    /// The live chapters' words.
    pub words: u64,
    /// `None`: no target (turned off).
    pub word_target: Option<i64>,
    /// The newest stored change, ms since the epoch.
    pub edited_ms: Option<i64>,
}

/// One book in Recently Deleted.
#[derive(Clone, Debug, PartialEq)]
pub struct TrashedBook {
    pub id: String,
    pub name: String,
    /// Whole days until it goes for good, rounded up; 0: due now.
    pub days_left: Option<i64>,
}

/// The whole shelf.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShelfData {
    /// Most recently changed first.
    pub books: Vec<ShelfBook>,
    /// Most recently deleted first.
    pub trashed: Vec<TrashedBook>,
}

impl ShelfData {
    /// Every book's words together.
    pub fn words(&self) -> u64 {
        self.books.iter().map(|b| b.words).sum()
    }

    /// Reads the shelf. Call it off the main thread: the first read of a
    /// book opens its document.
    pub fn load(lib: &Library) -> Result<ShelfData, WsError> {
        let mut data = ShelfData::default();
        // F3 sorts: live books by their last change, then the trashed ones,
        // most recently deleted first.
        for book in lib
            .run::<BookShelf>(&Actor::User, ListBooksIn { trashed: true })?
            .output
        {
            if book.info.trashed {
                data.trashed.push(TrashedBook {
                    id: book.info.id,
                    name: book.info.name,
                    days_left: book.days_left,
                });
                continue;
            }
            data.books.push(ShelfBook {
                id: book.info.id,
                name: book.info.name,
                summary: book.info.summary,
                subtitle: book.subtitle,
                chapters: book.chapters,
                storylines: book.storylines,
                elements: book.elements,
                words: book.words,
                word_target: book.info.word_target,
                edited_ms: book.updated_at.map(|s| s * 1000),
            });
        }
        Ok(data)
    }
}

/// How a book is doing by its last edit (the 0.1 shelf's `statusFor`):
/// 在写 within a week, 草稿 within a month, 搁置 after.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Writing,
    Draft,
    Paused,
}

impl Status {
    pub fn of(edited_ms: Option<i64>, now_ms: i64) -> Status {
        let Some(at) = edited_ms else {
            return Status::Draft;
        };
        let days = (now_ms - at) as f64 / 86_400_000.0;
        if days <= 7.0 {
            Status::Writing
        } else if days <= 30.0 {
            Status::Draft
        } else {
            Status::Paused
        }
    }
}

/// Progress towards the word target, 0–1; `None` without a target.
pub fn progress(words: u64, target: Option<i64>) -> Option<f32> {
    let target = target.filter(|t| *t > 0)?;
    Some((words as f64 / target as f64).clamp(0.0, 1.0) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_follows_the_last_edit() {
        let day = 86_400_000;
        let now = 100 * day;
        assert_eq!(Status::of(Some(now - 2 * day), now), Status::Writing);
        assert_eq!(Status::of(Some(now - 7 * day), now), Status::Writing);
        assert_eq!(Status::of(Some(now - 8 * day), now), Status::Draft);
        assert_eq!(Status::of(Some(now - 30 * day), now), Status::Draft);
        assert_eq!(Status::of(Some(now - 31 * day), now), Status::Paused);
        assert_eq!(Status::of(None, now), Status::Draft);
    }

    #[test]
    fn progress_needs_a_target() {
        assert_eq!(progress(500, None), None);
        assert_eq!(progress(500, Some(0)), None);
        assert_eq!(progress(500, Some(1000)), Some(0.5));
        assert_eq!(progress(5000, Some(1000)), Some(1.0));
    }
}
