//! A chapter after months of revision.
//!
//! [`age`] takes a seeded chapter and revises it in *sessions*: one sitting,
//! on one device, on one day. A session is a run of *actions*, each a few
//! commits the way an editor makes them (one commit per input-method
//! phrase, per Backspace, per selection deleted):
//!
//! | action | what the author does | commits |
//! | --- | --- | --- |
//! | rewrite | selects a paragraph, deletes it, types one of the same length | 1 delete, then a phrase of 1–6 characters each, with a typo fixed about every tenth phrase |
//! | touch-up | fixes a word: 1–3 Backspaces, then the right characters | 1 per Backspace, 1 for the phrase |
//! | sentence | types a sentence of 8–40 characters somewhere, cuts as much elsewhere | phrases, then 1 delete |
//! | structure | presses Enter in a paragraph, or joins two | 1 |
//! | style | makes a few characters bold, or plain again | 1 |
//!
//! The visible length stays where the seed put it (every action gives back
//! what it takes), so tiers differ only in how much history is underneath.
//! Commit timestamps advance like typing (about a second per phrase, a pause
//! between actions, a day or more between sessions), which is what decides
//! where Loro cuts its changes. With several devices each has its own
//! replica and peer; a device syncs before it starts a session, except that
//! one session in [`ChapterAging::concurrent_one_in`] starts without the
//! previous session of another device (the author wrote on a laptop that had
//! been offline), so the history really forks and merges.

use dr_doc::Result;
use dr_doc::prose::{ProseDoc, StyleKey};
use dr_model::Origin;
use dr_model::prose::InlineStyle;

use super::{DAY_S, device_peer, ops};
use crate::rng::Rng;
use crate::seed::T0;
use crate::text;

/// How often each action is picked (relative weights).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Mix {
    pub rewrite: u32,
    pub touch: u32,
    pub sentence: u32,
    pub structure: u32,
    pub style: u32,
}

impl Mix {
    /// Revision as the module comment describes it: by operations about
    /// three quarters paragraph rewrites, a fifth moved sentences and the
    /// rest small fixes; by count mostly small fixes.
    pub const REVISION: Mix = Mix {
        rewrite: 12,
        touch: 60,
        sentence: 20,
        structure: 4,
        style: 4,
    };
    /// Only small fixes scattered over the chapter: the most pieces per
    /// operation, the worst case for anything that walks the history.
    pub const SCATTERED: Mix = Mix {
        rewrite: 0,
        touch: 95,
        sentence: 5,
        structure: 0,
        style: 0,
    };

    fn total(&self) -> u32 {
        self.rewrite + self.touch + self.sentence + self.structure + self.style
    }
}

/// How to age a chapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAging {
    pub seed: u64,
    /// Stop once the history holds this many operations ([`super::ops`]).
    pub target_ops: usize,
    /// Devices the author writes on (at least 1).
    pub devices: usize,
    /// One session in this many starts without the previous session of
    /// another device (0: never). Only with several devices.
    pub concurrent_one_in: u64,
    pub mix: Mix,
}

impl ChapterAging {
    /// One device, the revision mix.
    pub fn revision(target_ops: usize) -> Self {
        Self {
            seed: crate::seed::DEFAULT_SEED,
            target_ops,
            devices: 1,
            concurrent_one_in: 0,
            mix: Mix::REVISION,
        }
    }

    /// Three devices; one session in eight written offline.
    pub fn devices(target_ops: usize) -> Self {
        Self {
            devices: 3,
            concurrent_one_in: 8,
            ..Self::revision(target_ops)
        }
    }
}

/// What [`age`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStats {
    pub sessions: usize,
    /// Days from the first session to the last.
    pub days: i64,
    pub commits: usize,
    pub typed_chars: usize,
    pub deleted_chars: usize,
    pub concurrent_sessions: usize,
    /// Operations in the history when aging stopped.
    pub ops: usize,
    /// Visible characters before and after (newlines included).
    pub chars_before: usize,
    pub chars_after: usize,
}

/// An aged chapter: the first device's replica, level with every other.
pub struct AgedChapter {
    pub doc: ProseDoc,
    pub stats: ChapterStats,
}

/// Replacement text from the seed's corpus, one character at a time.
struct Corpus {
    rng: Rng,
    chars: Vec<char>,
    at: usize,
}

impl Corpus {
    fn new(seed: u64) -> Self {
        Self {
            rng: Rng::stream(seed, "aging-corpus", 0),
            chars: Vec::new(),
            at: 0,
        }
    }

    fn take(&mut self, n: usize) -> String {
        let mut s = String::with_capacity(n * 3);
        for _ in 0..n {
            if self.at == self.chars.len() {
                self.chars = text::body(&mut self.rng, 2_000, text::BodyShape::default())
                    .iter()
                    .flat_map(|p| p.text.chars())
                    .collect();
                self.at = 0;
            }
            s.push(self.chars[self.at]);
            self.at += 1;
        }
        s
    }
}

/// One device's session in progress.
struct Session<'a> {
    doc: &'a mut ProseDoc,
    rng: &'a mut Rng,
    corpus: &'a mut Corpus,
    /// Milliseconds since the epoch; commits carry it in seconds.
    clock_ms: &'a mut i64,
    stats: &'a mut ChapterStats,
    /// Characters typed minus characters deleted so far, all sessions.
    net: &'a mut i64,
}

impl Session<'_> {
    fn len(&self) -> usize {
        self.doc.view().len()
    }

    fn commit(
        &mut self,
        pause_ms: (usize, usize),
        f: impl FnOnce(&mut dr_doc::prose::ProseTxn<'_>) -> Result<()>,
    ) -> Result<()> {
        *self.clock_ms += self.rng.range(pause_ms.0, pause_ms.1) as i64;
        let (r, c) = self
            .doc
            .edit_at(Origin::User, Some(*self.clock_ms / 1_000), f);
        r?;
        self.stats.commits += usize::from(c.is_some());
        Ok(())
    }

    fn type_phrase(&mut self, at: usize, n: usize) -> Result<()> {
        let s = self.corpus.take(n);
        self.commit((500, 1_800), |t| t.insert_text(at, &s))?;
        self.stats.typed_chars += n;
        *self.net += n as i64;
        Ok(())
    }

    fn backspace(&mut self, at: usize) -> Result<()> {
        self.commit((120, 300), |t| t.delete(at - 1..at))?;
        self.stats.deleted_chars += 1;
        *self.net -= 1;
        Ok(())
    }

    fn cut(&mut self, range: std::ops::Range<usize>) -> Result<()> {
        let n = range.len();
        self.commit((800, 3_000), |t| t.delete(range))?;
        self.stats.deleted_chars += n;
        *self.net -= n as i64;
        Ok(())
    }

    /// Type `n` characters from `at` on, phrase by phrase, fixing a typo
    /// about every tenth phrase.
    fn type_run(&mut self, mut at: usize, n: usize) -> Result<()> {
        let start = at;
        let mut left = n;
        while left > 0 {
            let k = self.rng.range(1, 6).min(left);
            self.type_phrase(at, k)?;
            at += k;
            left -= k;
            if left > 0 && at - start >= 2 && self.rng.chance(0.1) {
                let back = self.rng.range(1, 2);
                for _ in 0..back {
                    self.backspace(at)?;
                    at -= 1;
                }
                left += back;
            }
        }
        Ok(())
    }

    /// A paragraph with at least `min` characters of text, if a few random
    /// picks find one: its text range.
    fn paragraph(&mut self, min: usize) -> Option<std::ops::Range<usize>> {
        let len = self.len();
        if len < 2 {
            return None;
        }
        for _ in 0..8 {
            let at = self.rng.range(0, len - 2);
            if let Ok(p) = self.doc.view().paragraph_at(at)
                && p.range.len() >= min
                && p.embed().is_none()
            {
                return Some(p.range);
            }
        }
        None
    }

    fn rewrite(&mut self) -> Result<()> {
        let Some(range) = self.paragraph(1) else {
            return Ok(());
        };
        let n = range.len();
        self.cut(range.clone())?;
        self.type_run(range.start, n)
    }

    fn touch(&mut self) -> Result<()> {
        let Some(range) = self.paragraph(4) else {
            return Ok(());
        };
        let n = self.rng.range(1, 3);
        let mut at = self.rng.range(range.start + n, range.end);
        for _ in 0..n {
            self.backspace(at)?;
            at -= 1;
        }
        self.type_phrase(at, n)
    }

    fn sentence(&mut self) -> Result<()> {
        let n = self.rng.range(8, 40);
        // Give back what earlier actions left over, so the length stays put.
        let give = (n as i64 + *self.net).clamp(0, 2 * n as i64) as usize;
        if let Some(range) = self.paragraph(1) {
            let at = self.rng.range(range.start, range.end);
            self.type_run(at, n)?;
        }
        if give > 0
            && let Some(range) = self.paragraph(give + 1)
        {
            let start = self.rng.range(range.start, range.end - give);
            self.cut(start..start + give)?;
        }
        Ok(())
    }

    fn structure(&mut self, paragraphs_at_start: usize) -> Result<()> {
        let count = self.doc.view().paragraph_count();
        if count <= paragraphs_at_start {
            let Some(range) = self.paragraph(2) else {
                return Ok(());
            };
            let at = self.rng.range(range.start + 1, range.end - 1);
            self.commit((300, 900), |t| t.split(at).map(|_| ()))?;
            self.stats.typed_chars += 1;
            *self.net += 1;
        } else {
            let Some(range) = self.paragraph(1) else {
                return Ok(());
            };
            // The newline that ends this paragraph; the last one stays.
            if range.end + 1 < self.len() {
                self.commit((300, 900), |t| t.delete(range.end..range.end + 1))?;
                self.stats.deleted_chars += 1;
                *self.net -= 1;
            }
        }
        Ok(())
    }

    fn style(&mut self) -> Result<()> {
        let Some(range) = self.paragraph(4) else {
            return Ok(());
        };
        let n = self.rng.range(2, range.len().min(8));
        let start = self.rng.range(range.start, range.end - n);
        let on = self.rng.chance(0.6);
        self.commit((600, 2_000), |t| {
            if on {
                t.set_style(start..start + n, &InlineStyle::Bold)
            } else {
                t.clear_style(start..start + n, StyleKey::Bold)
            }
        })
    }

    fn action(&mut self, mix: &Mix, paragraphs_at_start: usize) -> Result<()> {
        // Thinking between two actions.
        *self.clock_ms += self.rng.range(2_000, 20_000) as i64;
        let mut pick = self.rng.below(mix.total() as u64) as u32;
        let mut is = |weight: u32| {
            if pick < weight {
                true
            } else {
                pick -= weight;
                false
            }
        };
        if is(mix.rewrite) {
            self.rewrite()
        } else if is(mix.touch) {
            self.touch()
        } else if is(mix.sentence) {
            self.sentence()
        } else if is(mix.structure) {
            self.structure(paragraphs_at_start)
        } else {
            self.style()
        }
    }
}

fn sync(from: &ProseDoc, to: &mut ProseDoc) -> Result<()> {
    let bytes = from.export_updates_since(&to.version())?;
    to.import(&bytes, Origin::Sync)?;
    Ok(())
}

/// Age `base` (a seeded chapter) by `plan`. `base` is not changed; the
/// result is the first device's replica after a last sync with the others.
pub fn age(base: &ProseDoc, plan: &ChapterAging) -> Result<AgedChapter> {
    assert!(plan.devices >= 1, "an author writes on at least one device");
    assert!(plan.mix.total() > 0, "the mix picks no action");
    let id = base.doc_id().to_string();
    let history = base.export_updates_since(&Default::default())?;
    let mut replicas = Vec::with_capacity(plan.devices);
    for device in 0..plan.devices {
        let mut doc = ProseDoc::create(base.doc_id().clone(), device_peer(&id, device))?;
        doc.import(&history, Origin::Import)?;
        replicas.push(doc);
    }
    let mut rng = Rng::stream(
        plan.seed,
        "aging-chapter",
        dr_doc::peer::fnv1a64(id.as_bytes()),
    );
    let mut corpus = Corpus::new(plan.seed);
    let mut stats = ChapterStats {
        chars_before: base.view().len(),
        ..ChapterStats::default()
    };
    let paragraphs_at_start = base.view().paragraph_count();
    let mut net = 0i64;
    // The first session is the morning after the seed's day zero.
    let first_day = T0 / DAY_S + 1;
    let mut day = first_day;
    let mut last_device = 0usize;
    let mut last_end_ms = 0i64;
    // The sync a concurrent session skipped, done before the next one.
    let total = |r: &[ProseDoc]| -> usize {
        let mut vv = r[0].version();
        for d in &r[1..] {
            vv.merge(&d.version());
        }
        ops(&vv)
    };
    while total(&replicas) < plan.target_ops {
        // Mostly the first device, the others now and then.
        let device = if plan.devices == 1 || rng.chance(0.6) {
            0
        } else {
            rng.range(1, plan.devices - 1)
        };
        let concurrent = plan.devices > 1
            && plan.concurrent_one_in > 0
            && device != last_device
            && stats.sessions > 0
            && rng.below(plan.concurrent_one_in) == 0;
        for other in 0..plan.devices {
            if other == device || (concurrent && other == last_device) {
                continue;
            }
            let (a, b) = pair(&mut replicas, other, device);
            sync(a, b)?;
        }
        stats.concurrent_sessions += usize::from(concurrent);
        // A concurrent session is the same day as the one it missed.
        if !concurrent {
            day += rng.range(1, 4) as i64;
        }
        // Never before the end of the session before it, whichever device
        // that was on: a peer's own commits must not go back in time.
        let mut clock_ms = ((day * DAY_S + rng.range(8 * 3_600, 21 * 3_600) as i64) * 1_000)
            .max(last_end_ms + 60_000);
        let budget = rng.range(800, 4_000);
        let before = ops(&replicas[device].version());
        let behind = total(&replicas) - before;
        loop {
            let now = ops(&replicas[device].version());
            // The other replicas are level with this one or behind it by
            // what a concurrent session skipped, so this is the total.
            if now - before >= budget || now + behind >= plan.target_ops {
                break;
            }
            let mut session = Session {
                doc: &mut replicas[device],
                rng: &mut rng,
                corpus: &mut corpus,
                clock_ms: &mut clock_ms,
                stats: &mut stats,
                net: &mut net,
            };
            session.action(&plan.mix, paragraphs_at_start)?;
        }
        stats.sessions += 1;
        last_device = device;
        last_end_ms = clock_ms;
    }
    // Everything meets on the first device.
    for other in 1..plan.devices {
        let (a, b) = pair(&mut replicas, other, 0);
        sync(a, b)?;
    }
    let doc = replicas.swap_remove(0);
    stats.days = day - first_day;
    stats.ops = ops(&doc.version());
    stats.chars_after = doc.view().len();
    Ok(AgedChapter { doc, stats })
}

/// `(&v[from], &mut v[to])` for two different indexes.
fn pair(v: &mut [ProseDoc], from: usize, to: usize) -> (&ProseDoc, &mut ProseDoc) {
    assert_ne!(from, to);
    if from < to {
        let (a, b) = v.split_at_mut(to);
        (&a[from], &mut b[0])
    } else {
        let (a, b) = v.split_at_mut(from);
        (&b[0], &mut a[to])
    }
}
