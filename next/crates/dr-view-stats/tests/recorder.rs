//! The writing-day recorder: what counts as this device's writing, days,
//! reopening, storing; then the same over a real library.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dr_model::Day;
use dr_view_stats::recorder::{Source, Tracker};

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    chapters: HashMap<String, Vec<String>>,
    words: HashMap<String, u64>,
    stored: HashMap<(String, String), i64>,
    writes: u32,
}

impl Fake {
    fn with(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.0.lock().unwrap())
    }
    fn stored(&self, book: &str, day: &str) -> Option<i64> {
        self.0
            .lock()
            .unwrap()
            .stored
            .get(&(book.into(), day.into()))
            .copied()
    }
}

impl Source for Fake {
    fn chapters(&self, book: &str) -> Option<Vec<(String, u64)>> {
        let s = self.0.lock().unwrap();
        let docs = s.chapters.get(book)?;
        Some(
            docs.iter()
                .map(|d| (d.clone(), s.words.get(d).copied().unwrap_or(0)))
                .collect(),
        )
    }
    fn words(&self, doc: &str) -> Option<u64> {
        self.0.lock().unwrap().words.get(doc).copied()
    }
    fn stored(&self, book: &str, day: &Day) -> i64 {
        Fake::stored(self, book, day.as_str()).unwrap_or(0)
    }
    fn store(&self, book: &str, day: &Day, words: i64) -> bool {
        let mut s = self.0.lock().unwrap();
        s.writes += 1;
        s.stored.insert((book.into(), day.to_string()), words);
        true
    }
}

fn day(s: &str) -> Day {
    Day::parse(s).unwrap()
}

fn book() -> (Fake, Tracker<Fake>) {
    let fake = Fake::default();
    fake.with(|s| {
        s.chapters
            .insert("b".into(), vec!["node:a".into(), "node:c".into()]);
        s.words.insert("node:a".into(), 100);
        s.words.insert("node:c".into(), 40);
    });
    (fake.clone(), Tracker::new(fake))
}

/// The index of `doc` now says `words`, after a prose change from here or
/// elsewhere.
fn write(fake: &Fake, t: &mut Tracker<Fake>, doc: &str, words: u64, here: bool, today: &Day) {
    let now = Instant::now();
    t.prose(doc, Some("b"), here, today, now);
    fake.with(|s| {
        s.words.insert(doc.into(), words);
    });
    t.indexed(doc, today, now);
}

#[test]
fn only_this_devices_writing_counts() {
    let (fake, mut t) = book();
    let today = day("2026-11-08");
    assert!(t.track("b", &today));
    assert_eq!(t.today("b"), Some(0));
    write(&fake, &mut t, "node:a", 130, true, &today);
    assert_eq!(t.today("b"), Some(30));
    // Another device's words arrive: they move the baseline, not the day.
    write(&fake, &mut t, "node:c", 90, false, &today);
    assert_eq!(t.today("b"), Some(30));
    // An index rebuilt without a prose change here is not writing either.
    fake.with(|s| {
        s.words.insert("node:a".into(), 160);
    });
    t.indexed("node:a", &today, Instant::now());
    assert_eq!(t.today("b"), Some(30));
    // Deleting more than was written reads as zero, and writing back counts
    // from there.
    write(&fake, &mut t, "node:a", 100, true, &today);
    assert_eq!(t.today("b"), Some(0));
    write(&fake, &mut t, "node:a", 120, true, &today);
    assert_eq!(t.today("b"), Some(0), "still 10 below the day's start");
    write(&fake, &mut t, "node:a", 200, true, &today);
    assert_eq!(t.today("b"), Some(70));
}

#[test]
fn chapters_that_come_or_go_are_not_writing() {
    let (fake, mut t) = book();
    let today = day("2026-11-08");
    t.track("b", &today);
    write(&fake, &mut t, "node:a", 110, true, &today);
    // A chapter goes to the trash, another comes with its words.
    fake.with(|s| {
        s.chapters
            .insert("b".into(), vec!["node:a".into(), "node:new".into()]);
        s.words.insert("node:new".into(), 500);
    });
    t.chapters_changed("b", &today, Instant::now());
    assert_eq!(t.today("b"), Some(10));
    // Writing in the new chapter counts.
    write(&fake, &mut t, "node:new", 520, true, &today);
    assert_eq!(t.today("b"), Some(30));
    // Writing in the trashed chapter no longer does.
    write(&fake, &mut t, "node:c", 400, true, &today);
    assert_eq!(t.today("b"), Some(30));
}

#[test]
fn a_new_day_stores_the_old_one_and_reopening_keeps_the_morning() {
    let (fake, mut t) = book();
    let mon = day("2026-11-09");
    t.track("b", &mon);
    write(&fake, &mut t, "node:a", 150, true, &mon);
    assert_eq!(t.today("b"), Some(50));
    // Past midnight: Monday is stored, Tuesday starts at zero.
    let tue = day("2026-11-10");
    write(&fake, &mut t, "node:a", 170, true, &tue);
    assert_eq!(fake.stored("b", "2026-11-09"), Some(50));
    assert_eq!(t.today("b"), Some(20));
    t.persist(Instant::now(), Duration::ZERO);
    assert_eq!(fake.stored("b", "2026-11-10"), Some(20));
    // The app restarts: a new tracker starts the day where it was.
    let mut again = Tracker::new(fake.clone());
    again.track("b", &tue);
    assert_eq!(again.today("b"), Some(20));
    write(&fake, &mut again, "node:a", 180, true, &tue);
    assert_eq!(again.today("b"), Some(30));
}

#[test]
fn rows_are_written_once_a_minute_while_the_words_move() {
    let (fake, mut t) = book();
    let today = day("2026-11-08");
    t.track("b", &today);
    let start = Instant::now();
    write(&fake, &mut t, "node:a", 101, true, &today);
    let delay = Duration::from_secs(60);
    let next = t.persist(start, delay).expect("a write is due later");
    assert!(next > start);
    assert_eq!(fake.0.lock().unwrap().writes, 0);
    for w in 102..120 {
        write(&fake, &mut t, "node:a", w, true, &today);
        t.persist(start + Duration::from_secs(30), delay);
    }
    assert_eq!(fake.0.lock().unwrap().writes, 0);
    assert_eq!(
        t.persist(start + delay + Duration::from_secs(1), delay),
        None
    );
    assert_eq!(fake.0.lock().unwrap().writes, 1);
    assert_eq!(fake.stored("b", "2026-11-08"), Some(19));
    // Nothing moved since: nothing to write.
    t.persist(start + delay * 3, Duration::ZERO);
    assert_eq!(fake.0.lock().unwrap().writes, 1);
}

#[test]
fn a_book_this_device_does_not_write_is_not_followed() {
    let (fake, mut t) = book();
    let today = day("2026-11-08");
    write(&fake, &mut t, "node:a", 300, false, &today);
    assert_eq!(t.today("b"), None);
    // The first prose change from here starts following the book.
    write(&fake, &mut t, "node:a", 310, true, &today);
    assert_eq!(t.today("b"), Some(10));
}
