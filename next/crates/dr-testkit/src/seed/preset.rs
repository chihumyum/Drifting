//! Presets and length budgets.
//!
//! `lite` and `heavy` have exactly the scale of the 0.1 client's `lite` and
//! `stress` seeds (`docs/dev-cli/acceptance/seed-presets.json`): the same
//! count, total, shortest and longest body per kind. Their texts and
//! fingerprints are this kit's own; the old fingerprints hashed ProseMirror
//! text read back from SQLite rows in no fixed order, which the new storage
//! has no equivalent of.

use crate::rng::Rng;

/// A named seed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Preset {
    /// A few short bodies of every kind: unit tests.
    Tiny,
    /// 20 chapters, 150 000 words: daily development.
    Lite,
    /// 100 chapters, 1.5 million words: performance, the whole book, import,
    /// memory (`benchmarks.md` "重型种子").
    Heavy,
    /// The screenshot library: 《慢钟》 (an original novel written for the
    /// screenshots) and a shelf of other books with synthetic text.
    Showcase,
}

impl Preset {
    pub const ALL: [Preset; 4] = [Preset::Tiny, Preset::Lite, Preset::Heavy, Preset::Showcase];

    pub fn name(self) -> &'static str {
        match self {
            Preset::Tiny => "tiny",
            Preset::Lite => "lite",
            Preset::Heavy => "heavy",
            Preset::Showcase => "showcase",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.name() == s)
    }

    /// The budgets of a synthetic preset; `None` for [`Preset::Showcase`],
    /// which is built from the sample fixtures.
    pub fn spec(self) -> Option<Spec> {
        Some(match self {
            Preset::Tiny => Spec {
                book_name: "微型种子",
                chapters: Budget::new(4, 3_000, 300, 1_200, 1),
                elements: Budget::new(6, 900, 60, 300, 1),
                ideas: Budget::new(3, 600, 100, 300, 1),
                material_notes: Budget::new(2, 400, 100, 300, 1),
                storylines: Budget::new(2, 300, 100, 200, 1),
                categories: Budget::new(2, 200, 50, 150, 1),
                todos: Budget::new(3, 150, 30, 80, 1),
                comments: Budget::new(3, 150, 30, 80, 1),
                acts: 2,
                relations: 6,
                idea_groups: 1,
                material_folders: 1,
                writing_days: 5,
                time_pins: 1,
            },
            Preset::Lite => Spec {
                book_name: "轻量种子",
                chapters: Budget::new(20, 150_000, 2_000, 20_000, 1),
                elements: Budget::new(30, 50_000, 100, 10_000, 3),
                ideas: Budget::new(10, 20_000, 1_000, 5_000, 2),
                material_notes: Budget::new(12, 20_000, 500, 4_000, 1),
                storylines: Budget::new(2, 8_000, 1_500, 6_500, 1),
                categories: Budget::new(6, 1_800, 100, 600, 1),
                todos: Budget::new(12, 1_200, 40, 240, 1),
                comments: Budget::new(8, 1_200, 40, 300, 1),
                acts: 3,
                relations: 40,
                idea_groups: 2,
                material_folders: 2,
                writing_days: 60,
                time_pins: 3,
            },
            Preset::Heavy => Spec {
                book_name: "重型种子",
                chapters: Budget::new(100, 1_500_000, 2_000, 20_000, 1),
                elements: Budget::new(300, 500_000, 100, 10_000, 3),
                ideas: Budget::new(200, 1_000_000, 1_000, 50_000, 4),
                material_notes: Budget::new(60, 500_000, 500, 10_000, 1),
                storylines: Budget::new(3, 60_000, 5_000, 30_000, 1),
                categories: Budget::new(16, 16_000, 100, 3_000, 2),
                todos: Budget::new(120, 30_000, 50, 1_500, 3),
                comments: Budget::new(80, 40_000, 50, 3_000, 3),
                acts: 4,
                relations: 400,
                idea_groups: 6,
                material_folders: 4,
                writing_days: 371,
                time_pins: 8,
            },
            Preset::Showcase => return None,
        })
    }
}

/// How many bodies of one kind, and how long: exactly `total` words, the
/// shortest exactly `min`, the longest exactly `max`. A larger `skew` makes
/// most bodies short and a few long.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub count: usize,
    pub total: usize,
    pub min: usize,
    pub max: usize,
    pub skew: u32,
}

impl Budget {
    pub const fn new(count: usize, total: usize, min: usize, max: usize, skew: u32) -> Self {
        Self {
            count,
            total,
            min,
            max,
            skew,
        }
    }

    /// Whether the budget can hold its total with both ends present.
    pub fn is_feasible(&self) -> bool {
        self.count >= 2
            && self.min >= 20
            && self.max >= self.min
            && self.total >= self.max + (self.count - 1) * self.min
            && self.total <= self.min + (self.count - 1) * self.max
    }
}

/// Every count of a synthetic preset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spec {
    pub book_name: &'static str,
    pub chapters: Budget,
    pub elements: Budget,
    pub ideas: Budget,
    pub material_notes: Budget,
    pub storylines: Budget,
    pub categories: Budget,
    pub todos: Budget,
    pub comments: Budget,
    pub acts: usize,
    pub relations: usize,
    pub idea_groups: usize,
    pub material_folders: usize,
    pub writing_days: usize,
    pub time_pins: usize,
}

impl Spec {
    /// The body budgets by group name (the names [`crate::seed::Shape`]
    /// reports).
    pub fn groups(&self) -> [(&'static str, Budget); 8] {
        [
            ("chapters", self.chapters),
            ("elements", self.elements),
            ("ideas", self.ideas),
            ("materialNotes", self.material_notes),
            ("storylines", self.storylines),
            ("categories", self.categories),
            ("todos", self.todos),
            ("comments", self.comments),
        ]
    }
}

/// Lengths for `budget`, deterministically shuffled: the old seed's
/// `allocateSeedLengths` (one body at `min`, one at `max`, the rest filled
/// by weight, `0.01 + u^skew`).
pub fn allocate(budget: &Budget, rng: &mut Rng) -> Vec<usize> {
    assert!(budget.is_feasible(), "infeasible budget {budget:?}");
    let Budget {
        count,
        total,
        min,
        max,
        skew,
    } = *budget;
    let mut values = vec![min; count];
    values[1] = max;
    let weights: Vec<f64> = (0..count)
        .map(|_| 0.01 + rng.unit().powi(skew as i32))
        .collect();
    let mut remaining = total - values.iter().sum::<usize>();
    while remaining > 0 {
        let candidates: Vec<usize> = (2..count).filter(|&i| values[i] < max).collect();
        assert!(!candidates.is_empty(), "allocation exhausted capacity");
        let weight: f64 = candidates.iter().map(|&i| weights[i]).sum();
        let available = remaining;
        for &i in &candidates {
            let share = ((available as f64) * weights[i] / weight).floor() as usize;
            let amount = (max - values[i]).min(share).min(remaining);
            values[i] += amount;
            remaining -= amount;
        }
        if remaining == available {
            for &i in &candidates {
                if remaining == 0 {
                    break;
                }
                values[i] += 1;
                remaining -= 1;
            }
        }
    }
    for i in (1..count).rev() {
        let other = rng.below(i as u64 + 1) as usize;
        values.swap(i, other);
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_budget_is_feasible_and_allocates_exactly() {
        for preset in Preset::ALL {
            let Some(spec) = preset.spec() else { continue };
            for (name, b) in spec.groups() {
                assert!(b.is_feasible(), "{} {name}", preset.name());
                let v = allocate(&b, &mut Rng::new(42));
                assert_eq!(v.len(), b.count, "{name}");
                assert_eq!(v.iter().sum::<usize>(), b.total, "{name}");
                assert_eq!(*v.iter().min().unwrap(), b.min, "{name}");
                assert_eq!(*v.iter().max().unwrap(), b.max, "{name}");
            }
        }
    }
}
