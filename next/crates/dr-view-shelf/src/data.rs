//! What the bookshelf shows, read through F3 (`dr-workspace`) off the main
//! thread: every book with its counts, words, word target and last edit,
//! and the books in Recently Deleted.
//!
//! - Counts come from F3's queries (`book.get`, `storyline.list`,
//!   `chapter.list`, `fact.list`).
//! - Words are the live chapters' words in the derived index (dr-store's
//!   `index_state`, kept by dr-index), as the 0.1 shelf counted them: only
//!   chapters, not ideas, elements or notes.
//! - The last edit is the newest stored change of any of the book's
//!   documents (dr-store's `loro_head`); the book document holds no
//!   `updated_at` (simplifications.md, 第一节第 13 条).

use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::{
        BookIn, ListIn,
        book::{BookGet, BookList, FactList, ListBooksIn},
        chapter::ChapterList,
        storyline::StorylineList,
    },
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
}

/// The whole shelf.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShelfData {
    /// Most recently edited first.
    pub books: Vec<ShelfBook>,
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
        let me = &Actor::User;
        let mut data = ShelfData::default();
        for info in lib
            .run::<BookList>(me, ListBooksIn { trashed: true })?
            .output
        {
            if info.trashed {
                data.trashed.push(TrashedBook {
                    id: info.id,
                    name: info.name,
                });
                continue;
            }
            match read_book(lib, &info.id) {
                Ok(book) => data.books.push(book),
                // One unreadable book leaves the rest of the shelf.
                Err(error) => log::warn!("book {} not on the shelf: {error}", info.id),
            }
        }
        data.books.sort_by(|a, b| {
            b.edited_ms
                .cmp(&a.edited_ms)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.id.cmp(&b.id))
        });
        data.trashed.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(data)
    }
}

fn read_book(lib: &Library, id: &str) -> Result<ShelfBook, WsError> {
    let me = &Actor::User;
    let list = || ListIn {
        book: id.to_owned(),
        trashed: false,
    };
    let detail = lib
        .run::<BookGet>(
            me,
            BookIn {
                book: id.to_owned(),
            },
        )?
        .output;
    let chapters = lib.run::<ChapterList>(me, list())?.output;
    let storylines = lib.run::<StorylineList>(me, list())?.output;
    let facts = lib
        .run::<FactList>(
            me,
            BookIn {
                book: id.to_owned(),
            },
        )?
        .output;
    let chapter_docs: Vec<String> = chapters.iter().map(|c| format!("node:{}", c.id)).collect();
    Ok(ShelfBook {
        id: id.to_owned(),
        name: detail.info.name,
        summary: detail.info.summary,
        subtitle: facts
            .iter()
            .find(|f| f.key.trim() == "副标题")
            .map(|f| f.value.trim().to_owned())
            .filter(|v| !v.is_empty()),
        chapters: detail.chapters,
        storylines: storylines.len() as u32,
        elements: detail.elements,
        words: words_of(lib, &chapter_docs),
        word_target: detail.info.word_target,
        edited_ms: edited_ms(lib, id),
    })
}

/// The words of `docs` in the derived index (a document not indexed yet
/// counts 0 until dr-index reaches it).
pub fn words_of(lib: &Library, docs: &[String]) -> u64 {
    let store = lib.library();
    docs.iter()
        .filter_map(|d| store.doc_stats(d).ok().flatten())
        .map(|s| s.words)
        .sum()
}

/// When `doc` last changed (its newest stored update), ms since the epoch.
pub fn doc_edited_ms(lib: &Library, doc: &str) -> Option<i64> {
    lib.library().head(doc).ok().flatten().map(|h| h.ts)
}

/// When any of `book`'s documents last changed, ms since the epoch.
pub fn edited_ms(lib: &Library, book: &str) -> Option<i64> {
    let store = lib.library();
    let mut docs: Vec<String> = store
        .docs(Some(book), None)
        .map(|d| d.into_iter().map(|d| d.doc_id).collect())
        .unwrap_or_default();
    docs.push(format!("book:{book}"));
    docs.iter().filter_map(|d| doc_edited_ms(lib, d)).max()
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
