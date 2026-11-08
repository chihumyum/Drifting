//! What the Stats tab reads, without GPUI: which count to show first, the
//! live counts swapped into the index's totals, today's words, progress.

use std::collections::HashMap;

use dr_text::{TextMetrics, with_live};
use dr_workspace::NavTarget;
use dr_workspace::commands::stats::{Count, WordCountsOut, WritingDaysOut};

/// The most specific thing a count can be shown for (the 0.1 client's
/// `deriveStatusWordMetric`): the selection, the open chapter or idea, the
/// open storyline, then the book.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    Selection,
    Chapter,
    Idea,
    Storyline,
    Book,
}

/// One count: `None` while it is still being counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub scope: Scope,
    pub words: Option<u64>,
}

/// The editor's own counts: the documents it has open and the selection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Live {
    pub docs: HashMap<String, TextMetrics>,
    /// Words in the selection, when there is one.
    pub selection: Option<u64>,
}

impl Live {
    fn doc(&self, doc: &str) -> Option<TextMetrics> {
        self.docs.get(doc).copied()
    }
}

fn metrics(c: Count) -> TextMetrics {
    TextMetrics {
        words: c.words,
        chars: c.chars,
    }
}

/// The book's words: the index's chapters, each open one counted live.
pub fn book_words(counts: &WordCountsOut, live: &Live) -> Option<u64> {
    let mut total = metrics(counts.book);
    let mut counted = counts.counted;
    for c in &counts.chapters {
        if let Some(l) = live.doc(&c.doc) {
            total = with_live(total, metrics(c.count), l);
            counted |= c.counted;
        }
    }
    counted.then_some(total.words)
}

/// A storyline's words, open chapters counted live.
pub fn storyline_words(counts: &WordCountsOut, storyline: &str, live: &Live) -> Option<u64> {
    let s = counts.storylines.iter().find(|s| s.id == storyline)?;
    let mut total = metrics(s.count);
    for c in counts
        .chapters
        .iter()
        .filter(|c| c.storylines.iter().any(|x| x == storyline))
    {
        if let Some(l) = live.doc(&c.doc) {
            total = with_live(total, metrics(c.count), l);
        }
    }
    s.counted.then_some(total.words)
}

/// What to show first for the page `current`.
pub fn reading(
    current: Option<&NavTarget>,
    counts: Option<&WordCountsOut>,
    live: &Live,
) -> Reading {
    if let Some(words) = live.selection {
        return Reading {
            scope: Scope::Selection,
            words: Some(words),
        };
    }
    let Some(counts) = counts else {
        let scope = match current {
            Some(NavTarget::Chapter(_)) => Scope::Chapter,
            Some(NavTarget::Idea(_)) => Scope::Idea,
            Some(NavTarget::Storyline(_)) => Scope::Storyline,
            _ => Scope::Book,
        };
        return Reading { scope, words: None };
    };
    let node = |id: &str, scope: Scope, list: &[dr_workspace::commands::stats::DocCount]| {
        let words = match live.doc(&format!("node:{id}")) {
            Some(l) => Some(l.words),
            None => list
                .iter()
                .find(|c| c.id == id)
                .and_then(|c| c.counted.then_some(c.count.words)),
        };
        Reading { scope, words }
    };
    match current {
        Some(NavTarget::Chapter(id)) => node(id.as_str(), Scope::Chapter, &counts.chapters),
        Some(NavTarget::Idea(id)) => node(id.as_str(), Scope::Idea, &counts.ideas),
        Some(NavTarget::Storyline(id)) => Reading {
            scope: Scope::Storyline,
            words: storyline_words(counts, id.as_str(), live),
        },
        _ => Reading {
            scope: Scope::Book,
            words: book_words(counts, live),
        },
    }
}

/// Today's words over all devices: what the book document holds, with
/// this device's part replaced by the recorder's live tally.
pub fn today_words(days: &WritingDaysOut, mine_live: Option<i64>) -> i64 {
    match mine_live {
        Some(mine) => (days.today - days.mine_today).max(0) + mine,
        None => days.today,
    }
}

/// How far `value` has gone toward `target`, 0–1; `None` without a target.
pub fn progress(value: u64, target: Option<i64>) -> Option<f32> {
    let target = target.filter(|t| *t > 0)?;
    Some((value as f64 / target as f64).clamp(0.0, 1.0) as f32)
}

/// Digits grouped by three the way `locale` writes them (the 0.1 client
/// used `toLocaleString`; `dr_i18n::number::grouped` with a sign).
pub fn grouped(n: i64, locale: dr_i18n::Locale) -> String {
    let digits = dr_i18n::number::grouped(n.unsigned_abs(), locale);
    if n < 0 { format!("-{digits}") } else { digits }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dr_workspace::commands::stats::{DocCount, StorylineCount};

    fn counts() -> WordCountsOut {
        let doc = |id: &str, words: u64, counted: bool| DocCount {
            id: id.into(),
            doc: format!("node:{id}"),
            count: Count {
                words,
                chars: words,
            },
            counted,
            storylines: Vec::new(),
        };
        let mut a = doc("a", 100, true);
        a.storylines.push("s".into());
        WordCountsOut {
            chapters: vec![a, doc("b", 50, true)],
            ideas: vec![doc("i", 7, true)],
            storylines: vec![StorylineCount {
                id: "s".into(),
                count: Count {
                    words: 100,
                    chars: 100,
                },
                chapters: 1,
                counted: true,
            }],
            book: Count {
                words: 150,
                chars: 150,
            },
            counted: true,
            word_target: Some(1000),
            daily_word_target: Some(10),
        }
    }

    fn id<T: std::str::FromStr>(s: &str) -> T
    where
        T::Err: std::fmt::Debug,
    {
        s.parse().unwrap()
    }

    #[test]
    fn the_most_specific_count_first() {
        let c = counts();
        let mut live = Live::default();
        let chapter = NavTarget::Chapter(id("a"));
        assert_eq!(
            reading(Some(&chapter), Some(&c), &live),
            Reading {
                scope: Scope::Chapter,
                words: Some(100)
            }
        );
        assert_eq!(reading(None, Some(&c), &live).words, Some(150));
        let line = NavTarget::Storyline(id("s"));
        assert_eq!(
            reading(Some(&line), Some(&c), &live).scope,
            Scope::Storyline
        );
        assert_eq!(reading(Some(&chapter), None, &live).words, None);
        // The editor's counts win over the index's.
        live.docs.insert(
            "node:a".into(),
            TextMetrics {
                words: 120,
                chars: 120,
            },
        );
        assert_eq!(reading(Some(&chapter), Some(&c), &live).words, Some(120));
        assert_eq!(reading(None, Some(&c), &live).words, Some(170));
        assert_eq!(reading(Some(&line), Some(&c), &live).words, Some(120));
        live.selection = Some(3);
        assert_eq!(
            reading(Some(&chapter), Some(&c), &live),
            Reading {
                scope: Scope::Selection,
                words: Some(3)
            }
        );
    }

    #[test]
    fn today_swaps_in_this_devices_live_words() {
        let days = WritingDaysOut {
            days: Vec::new(),
            today: 500,
            mine_today: 300,
            week: 500,
            active_days: 1,
            streak: 1,
            streak_before: 0,
            daily_word_target: Some(1500),
        };
        assert_eq!(today_words(&days, None), 500);
        assert_eq!(today_words(&days, Some(450)), 650);
        assert_eq!(progress(750, Some(1500)), Some(0.5));
        assert_eq!(progress(3000, Some(1500)), Some(1.0));
        assert_eq!(progress(10, None), None);
        assert_eq!(progress(10, Some(0)), None);
    }

    #[test]
    fn numbers_are_grouped_by_locale() {
        use dr_i18n::Locale as L;
        assert_eq!(grouped(1_234_567, L::ZhCn), "1,234,567");
        assert_eq!(grouped(999, L::En), "999");
        assert_eq!(grouped(1234, L::De), "1.234");
        assert_eq!(grouped(1234, L::Es), "1234");
        assert_eq!(grouped(12_345, L::Es), "12.345");
        assert_eq!(grouped(-1500, L::Fr), "-1\u{202f}500");
    }
}
