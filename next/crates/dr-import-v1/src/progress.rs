//! What an import is doing, for the interface (F6): which step, which book,
//! how many of how many, and an overall estimate (`m10-import.md` "进度").
//!
//! The import calls the callback on its own thread, at least once per body,
//! asset and index document and every few megabytes while copying, so a
//! callback should only store the latest value (the interface repaints from
//! it). The steps come in order; within a step `done` only grows.

use serde::Serialize;

/// One step of an import, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    /// Copying the 0.1 database (and its `-wal`) byte for byte; `done` and
    /// `total` are bytes.
    Copying,
    /// Checking the copy, bringing it up to the last 0.1 schema, judging
    /// every body's freshness.
    Checking,
    /// Writing one book's bodies (prose documents); `done` / `total` are the
    /// book's bodies.
    Bodies,
    /// Writing the book document: catalogue, comments, and the snapshot
    /// history's metadata; `done` / `total` are the history rows replayed.
    Book,
    /// Copying the book's asset files; `done` / `total` are files.
    Assets,
    /// Labelling the history points and writing the receipt.
    Finishing,
    /// Building search, outlines and word counts; `done` / `total` are
    /// documents.
    Indexing,
    /// Finished (or stopped by the gate).
    Done,
}

/// One progress report.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: Step,
    /// The book being written, from 1; 0 outside the per-book steps.
    pub book: usize,
    pub books: usize,
    /// Its name ("" outside the per-book steps).
    pub book_name: String,
    pub done: u64,
    pub total: u64,
    /// The whole import, 0.0 to 1.0: an estimate from fixed shares per step
    /// (copying 15 %, checking 5 %, the books 60 % split by their bodies and
    /// assets, finishing 5 %, indexing 15 %). It never goes back.
    pub overall: f64,
}

/// A progress callback.
pub type Callback<'a> = &'a mut dyn FnMut(&Progress);

/// The shares of [`Progress::overall`]: where each step starts.
const COPY: (f64, f64) = (0.0, 0.15);
const CHECK: (f64, f64) = (0.15, 0.20);
const BOOKS: (f64, f64) = (0.20, 0.80);
const FINISH: (f64, f64) = (0.80, 0.85);
const INDEX: (f64, f64) = (0.85, 1.0);

/// Keeps the counts the overall estimate needs and calls the callback.
pub(crate) struct Reporter<'a> {
    callback: Callback<'a>,
    books: usize,
    /// Units (bodies + assets + one per book) of all books, and done so far
    /// in books already finished.
    units_total: u64,
    units_before: u64,
    last_overall: f64,
}

impl<'a> Reporter<'a> {
    pub fn new(callback: Callback<'a>) -> Self {
        Self {
            callback,
            books: 0,
            units_total: 0,
            units_before: 0,
            last_overall: 0.0,
        }
    }

    /// Before the books: how many there are and their units in all.
    pub fn plan_books(&mut self, books: usize, units: u64) {
        self.books = books;
        self.units_total = units.max(1);
    }

    fn emit(&mut self, step: Step, book: (usize, &str), done: u64, total: u64, overall: f64) {
        let overall = overall.clamp(self.last_overall, 1.0);
        self.last_overall = overall;
        (self.callback)(&Progress {
            step,
            book: book.0,
            books: self.books,
            book_name: book.1.to_string(),
            done,
            total,
            overall,
        });
    }

    fn within(band: (f64, f64), done: u64, total: u64) -> f64 {
        let f = if total == 0 {
            0.0
        } else {
            done as f64 / total as f64
        };
        band.0 + (band.1 - band.0) * f.clamp(0.0, 1.0)
    }

    pub fn copying(&mut self, done: u64, total: u64) {
        let o = Self::within(COPY, done, total);
        self.emit(Step::Copying, (0, ""), done, total, o);
    }

    pub fn checking(&mut self) {
        self.emit(Step::Checking, (0, ""), 0, 0, CHECK.0);
    }

    /// A step of book `book` (from 1), with `units_done` of the book's units
    /// finished so far.
    pub fn book_step(
        &mut self,
        step: Step,
        book: (usize, &str),
        done: u64,
        total: u64,
        units_done: u64,
    ) {
        let o = Self::within(BOOKS, self.units_before + units_done, self.units_total);
        self.emit(step, book, done, total, o);
    }

    /// Book finished: its units count as done.
    pub fn book_done(&mut self, units: u64) {
        self.units_before += units;
    }

    pub fn finishing(&mut self) {
        self.emit(Step::Finishing, (0, ""), 0, 0, FINISH.0);
    }

    pub fn indexing(&mut self, done: u64, total: u64) {
        let o = Self::within(INDEX, done, total);
        self.emit(Step::Indexing, (0, ""), done, total, o);
    }

    pub fn done(&mut self) {
        self.emit(Step::Done, (0, ""), 0, 0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_never_goes_back_and_ends_at_one() {
        let mut seen: Vec<Progress> = Vec::new();
        let mut cb = |p: &Progress| seen.push(p.clone());
        let mut r = Reporter::new(&mut cb);
        r.copying(0, 100);
        r.copying(100, 100);
        r.checking();
        r.plan_books(2, 10);
        r.book_step(Step::Bodies, (1, "甲"), 1, 4, 1);
        r.book_step(Step::Bodies, (1, "甲"), 4, 4, 4);
        r.book_done(5);
        r.book_step(Step::Bodies, (2, "乙"), 1, 4, 1);
        // An estimate that would go back (here: fewer units) is held.
        r.book_step(Step::Bodies, (2, "乙"), 0, 4, 0);
        r.book_done(5);
        r.finishing();
        r.indexing(3, 6);
        r.done();
        let overall: Vec<f64> = seen.iter().map(|p| p.overall).collect();
        assert!(overall.windows(2).all(|w| w[0] <= w[1]), "{overall:?}");
        assert_eq!(seen.last().unwrap().step, Step::Done);
        assert_eq!(seen.last().unwrap().overall, 1.0);
        assert_eq!(seen[4].books, 2);
        assert_eq!(seen[4].book_name, "甲");
        assert!((seen[1].overall - 0.15).abs() < 1e-9);
    }
}
