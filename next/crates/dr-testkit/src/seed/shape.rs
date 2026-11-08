//! What a seed contains: the contract its tests assert and its consumers
//! (benchmarks, evidence) record.

use std::collections::BTreeMap;

use serde::Serialize;

use super::build::SeededBook;
use crate::digest::Fingerprint;
use crate::text;

/// Sizes of one group of bodies.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupShape {
    pub count: usize,
    pub total_words: usize,
    pub min_words: usize,
    pub max_words: usize,
    pub median_words: f64,
    pub p95_words: usize,
    /// SHA-256 over the bodies' plain text, in creation order, each followed
    /// by a NUL (the 0.1 seed audit's construction).
    pub corpus_sha256: String,
}

impl GroupShape {
    fn of(bodies: &[String]) -> Self {
        let mut lengths: Vec<usize> = bodies.iter().map(|b| text::words(b)).collect();
        lengths.sort_unstable();
        let n = lengths.len();
        let mut h = sha2::Sha256::default();
        for b in bodies {
            sha2::Digest::update(&mut h, b.as_bytes());
            sha2::Digest::update(&mut h, [0u8]);
        }
        let median = match n {
            0 => 0.0,
            n if n % 2 == 1 => lengths[n / 2] as f64,
            n => (lengths[n / 2 - 1] + lengths[n / 2]) as f64 / 2.0,
        };
        Self {
            count: n,
            total_words: lengths.iter().sum(),
            min_words: lengths.first().copied().unwrap_or(0),
            max_words: lengths.last().copied().unwrap_or(0),
            median_words: median,
            p95_words: if n == 0 {
                0
            } else {
                lengths[(n * 95).div_ceil(100) - 1]
            },
            corpus_sha256: crate::digest::sha256_hex(&sha2::Digest::finalize(h)),
        }
    }
}

/// Everything a seed is made of.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub preset: String,
    pub seed: String,
    pub books: usize,
    /// Prose documents plus one book document per book.
    pub documents: usize,
    pub bodies: BTreeMap<String, GroupShape>,
    pub chapters: usize,
    pub elements: usize,
    pub relations: usize,
    pub acts: usize,
    pub writing_days: usize,
    pub entity_links: usize,
    /// H1, H2, H3 paragraphs.
    pub headings: [usize; 3],
    pub tasks: usize,
    /// One fingerprint over every group's corpus fingerprint.
    pub corpus_fingerprint: String,
}

impl Shape {
    pub(crate) fn of(preset: &str, seed: u64, books: &[SeededBook]) -> Self {
        let mut groups: BTreeMap<&str, Vec<String>> = BTreeMap::new();
        let mut links = 0;
        let mut headings = [0; 3];
        let mut tasks = 0;
        let (mut chapters, mut elements, mut relations, mut acts, mut days) = (0, 0, 0, 0, 0);
        for b in books {
            for (g, bodies) in b.groups() {
                groups.entry(g).or_default().extend(bodies.iter().cloned());
            }
            let counters = b.counters();
            links += counters.entity_links;
            for (a, x) in headings.iter_mut().zip(counters.headings) {
                *a += x;
            }
            tasks += counters.tasks;
            let v = b.book.view();
            chapters += v.chapters().len();
            elements += v.elements().len();
            relations += v.relations().len();
            acts += v.acts().len();
            days += v.writing_days().len();
        }
        let bodies: BTreeMap<String, GroupShape> = groups
            .iter()
            .map(|(g, b)| (g.to_string(), GroupShape::of(b)))
            .collect();
        let mut fp = Fingerprint::new();
        for (g, s) in &bodies {
            fp.part(g, s.corpus_sha256.as_bytes());
        }
        Self {
            preset: preset.into(),
            seed: format!("{seed:#x}"),
            books: books.len(),
            documents: books.iter().map(|b| b.prose.len() + 1).sum(),
            bodies,
            chapters,
            elements,
            relations,
            acts,
            writing_days: days,
            entity_links: links,
            headings,
            tasks,
            corpus_fingerprint: fp.finish(),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("a shape serializes")
    }
}
