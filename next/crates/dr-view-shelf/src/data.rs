//! What the bookshelf shows, read through F3 (`dr-workspace`) off the main
//! thread in one query (`book.shelf`): every book with its counts, words,
//! word target and last change, and the books in Recently Deleted with the
//! days they have left.
//!
//! - Words are the manuscript sequence's words (`in_book` prose modules) in
//!   the derived index: off-manuscript entries and prose modules with `in_book`
//!   turned off are excluded.
//! - The last change is the newest stored change of any of the book's
//!   documents; the book document holds no `updated_at`
//!   (simplifications.md, 第一节第 13 条).

use std::collections::{BTreeMap, BTreeSet};

use dr_workspace::{
    Actor, Workspace as Library, WsError,
    commands::book::{BookShelf, ListBooksIn},
};

/// Maximum number of recently modified entries shown on hover for a bookless project.
pub const MAX_RECENT_ENTRIES: usize = 4;

/// One recently modified entry in a project (`kernel-v5.md` §3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentEntry {
    pub id: String,
    pub title: String,
    /// Newest change of the entry or its prose documents, ms since the epoch.
    pub edited_ms: Option<i64>,
}

/// One book on the shelf.
#[derive(Clone, Debug, PartialEq)]
pub struct ShelfBook {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// The 「副标题」 project fact, as the 0.1 shelf read it.
    pub subtitle: Option<String>,
    /// Whether `成书` (`project.book`) is enabled on this project.
    pub has_book: bool,
    pub chapters: u32,
    pub storylines: u32,
    pub elements: u32,
    /// Live content entries in this project.
    pub entry_count: u32,
    /// Recently modified live content entries, newest first.
    pub recent_entries: Vec<RecentEntry>,
    /// The live chapters' words (`None` while indexing, or when `has_book` is `false`).
    pub words: Option<u64>,
    /// `None`: no target (turned off, or `has_book` is `false`).
    pub word_target: Option<i64>,
    /// The newest stored change, ms since the epoch.
    pub edited_ms: Option<i64>,
}

impl Default for ShelfBook {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            summary: String::new(),
            subtitle: None,
            has_book: true,
            chapters: 0,
            storylines: 0,
            elements: 0,
            entry_count: 0,
            recent_entries: Vec::new(),
            words: None,
            word_target: None,
            edited_ms: None,
        }
    }
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
    /// Every book-enabled project's words together (`None` when all projects on
    /// a non-empty shelf have `成书` turned off, or while an index is counting).
    pub fn words(&self) -> Option<u64> {
        if self.books.is_empty() {
            return Some(0);
        }
        if !self.books.iter().any(|book| book.has_book) {
            return None;
        }
        self.books
            .iter()
            .filter(|book| book.has_book)
            .try_fold(0u64, |sum, book| Some(sum + book.words?))
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
            let (has_book, entry_count, recent_entries) = read_entry_summary(lib, &book.info.id);
            data.books.push(ShelfBook {
                id: book.info.id,
                name: book.info.name,
                summary: book.info.summary,
                subtitle: book.subtitle,
                has_book,
                chapters: if has_book { book.chapters } else { 0 },
                storylines: book.storylines,
                elements: book.elements,
                entry_count,
                recent_entries,
                words: if has_book { book.words } else { None },
                word_target: if has_book {
                    book.info.word_target
                } else {
                    None
                },
                edited_ms: book.updated_at.map(|s| s * 1000),
            });
        }
        Ok(data)
    }
}

fn read_entry_summary(lib: &Library, book_id: &str) -> (bool, u32, Vec<RecentEntry>) {
    let Ok(snapshot) = dr_shell::book::Book::load(lib, book_id) else {
        return (true, 0, Vec::new());
    };
    let Some(v) = snapshot.v3() else {
        return (true, 0, Vec::new());
    };
    let has_book = v.project.book.is_some();
    let mut body_ts: BTreeMap<String, i64> = BTreeMap::new();
    if let Ok(docs) = lib.library().docs(Some(book_id), Some("body")) {
        for doc in docs {
            let Some(rest) = doc.doc_id.strip_prefix("body:") else {
                continue;
            };
            let entry_id = rest.split('/').next().unwrap_or(rest);
            if let Ok(Some(head)) = lib.library().head(&doc.doc_id) {
                body_ts
                    .entry(entry_id.to_owned())
                    .and_modify(|cur| *cur = (*cur).max(head.ts))
                    .or_insert(head.ts);
            }
        }
    }
    let mut live: Vec<(usize, RecentEntry)> = v
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| v.is_content(&e.id) && ancestors_live(v, e.parent.as_deref()))
        .map(|(idx, e)| {
            let entry_ms = e.updated_at.or(e.created_at).map(|s| s * 1000);
            let edited_ms = match (body_ts.get(&e.id).copied(), entry_ms) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            (
                idx,
                RecentEntry {
                    id: e.id.clone(),
                    title: e.title.clone(),
                    edited_ms,
                },
            )
        })
        .collect();
    let count = live.len() as u32;
    live.sort_by(|(idx_a, a), (idx_b, b)| {
        b.edited_ms.cmp(&a.edited_ms).then_with(|| idx_b.cmp(idx_a))
    });
    let recent = live
        .into_iter()
        .take(MAX_RECENT_ENTRIES)
        .map(|(_, entry)| entry)
        .collect();
    (has_book, count, recent)
}

fn ancestors_live<'a>(v: &'a dr_shell::book::v3::BookV3, mut cur: Option<&'a str>) -> bool {
    let mut seen = BTreeSet::new();
    while let Some(id) = cur {
        if !seen.insert(id) {
            return false;
        }
        let Some(entry) = v.entry(id) else {
            return false;
        };
        cur = entry.parent.as_deref();
    }
    true
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
