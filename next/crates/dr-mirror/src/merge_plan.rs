//! Which paragraphs of the file are the base's, changed, new or gone (the
//! 0.1 client's planning in `markdown-mirror/ingest.ts`).
//!
//! Paragraphs are compared by their line: the base's written out, the
//! file's as the author left it. Lines equal on both sides are kept as they
//! are (a paragraph's alignment, indent and entity links, which a file
//! does not show, stay). Between two kept stretches, a base paragraph and a
//! file paragraph are paired only when they are alike (character-bigram
//! Dice ≥ 0.3); a pair is an edit of the paragraph, so its block id,
//! comments and links stay. Unpaired ones are deleted or inserted, so a new
//! paragraph never takes an old one's identity.

use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::body::{Kind, Para};

/// How alike two paragraphs must be to be one paragraph edited.
pub const ALIKE: f64 = 0.3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Keep { base: usize, file: usize },
    Change { base: usize, file: usize },
    Delete { base: usize },
    Insert { file: usize },
}

/// The steps from `base` to `file`, in document order. `keys` are the
/// paragraphs' lines.
pub fn plan(base: &[(String, Para)], file: &[(String, Para)]) -> Vec<Step> {
    let a: Vec<&str> = base.iter().map(|(k, _)| k.as_str()).collect();
    let b: Vec<&str> = file.iter().map(|(k, _)| k.as_str()).collect();
    let mut steps = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, &a, &b) {
        match op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => steps.extend((0..len).map(|k| Step::Keep {
                base: old_index + k,
                file: new_index + k,
            })),
            DiffOp::Delete {
                old_index, old_len, ..
            } => steps.extend((old_index..old_index + old_len).map(|base| Step::Delete { base })),
            DiffOp::Insert {
                new_index, new_len, ..
            } => steps.extend((new_index..new_index + new_len).map(|file| Step::Insert { file })),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => steps.extend(pair(
                base,
                file,
                old_index..old_index + old_len,
                new_index..new_index + new_len,
            )),
        }
    }
    steps
}

/// Pair alike paragraphs of a gap in order (the most pairs), the rest
/// deleted or inserted; deletions of a stretch come before its insertions.
fn pair(
    base: &[(String, Para)],
    file: &[(String, Para)],
    olds: std::ops::Range<usize>,
    news: std::ops::Range<usize>,
) -> Vec<Step> {
    let (n, m) = (olds.len(), news.len());
    let alike = |i: usize, j: usize| {
        let (p, q) = (&base[olds.start + i].1, &file[news.start + j].1);
        pairable(p, q) && dice(&p.chars, &q.chars) >= ALIKE
    };
    // best[i][j]: most pairs in olds[i..] × news[j..].
    let mut best = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            let mut v = best[i + 1][j].max(best[i][j + 1]);
            if alike(i, j) {
                v = v.max(best[i + 1][j + 1] + 1);
            }
            best[i][j] = v;
        }
    }
    let mut steps = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut pending_inserts = Vec::new();
    while i < n || j < m {
        if i < n && j < m && alike(i, j) && best[i][j] == best[i + 1][j + 1] + 1 {
            steps.append(&mut pending_inserts);
            steps.push(Step::Change {
                base: olds.start + i,
                file: news.start + j,
            });
            i += 1;
            j += 1;
        } else if i < n && (j == m || best[i][j] == best[i + 1][j]) {
            steps.push(Step::Delete {
                base: olds.start + i,
            });
            i += 1;
        } else {
            pending_inserts.push(Step::Insert {
                file: news.start + j,
            });
            j += 1;
        }
    }
    steps.append(&mut pending_inserts);
    steps
}

/// Whether one paragraph can become the other by editing it (an embed is
/// only ever kept or deleted).
fn pairable(a: &Para, b: &Para) -> bool {
    !matches!(a.kind, Kind::Embed(_)) && !matches!(b.kind, Kind::Embed(_))
}

/// Sørensen–Dice over character bigrams; two texts with no bigram are
/// alike when equal.
pub fn dice(a: &[char], b: &[char]) -> f64 {
    if a.len() < 2 || b.len() < 2 {
        return if a == b { 1.0 } else { 0.0 };
    }
    let mut counts: std::collections::HashMap<(char, char), i32> = std::collections::HashMap::new();
    for w in a.windows(2) {
        *counts.entry((w[0], w[1])).or_default() += 1;
    }
    let mut both = 0;
    for w in b.windows(2) {
        if let Some(c) = counts.get_mut(&(w[0], w[1]))
            && *c > 0
        {
            *c -= 1;
            both += 1;
        }
    }
    2.0 * both as f64 / ((a.len() - 1) + (b.len() - 1)) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::Marks;

    fn p(s: &str) -> (String, Para) {
        (
            s.to_owned(),
            Para {
                kind: Kind::Text {
                    heading: None,
                    quote: false,
                },
                chars: s.chars().collect(),
                marks: vec![Marks::default(); s.chars().count()],
            },
        )
    }

    fn ps(v: &[&str]) -> Vec<(String, Para)> {
        v.iter().map(|s| p(s)).collect()
    }

    #[test]
    fn alike_paragraphs_pair_and_new_ones_do_not() {
        let base = ps(&["钟楼在镇口的石桥边。", "她没回头。", "雨下了一夜。"]);
        let file = ps(&[
            "钟楼在镇口的旧石桥边。",
            "完全不同的一段新话。",
            "雨下了一夜。",
        ]);
        assert_eq!(
            plan(&base, &file),
            [
                Step::Change { base: 0, file: 0 },
                Step::Delete { base: 1 },
                Step::Insert { file: 1 },
                Step::Keep { base: 2, file: 2 },
            ]
        );
    }

    #[test]
    fn a_paragraph_split_in_two_keeps_its_identity_once() {
        let base = ps(&["甲。", "钟楼在镇口的石桥边，雨下了一夜。", "乙。"]);
        let file = ps(&["甲。", "钟楼在镇口的石桥边，", "雨下了一夜。", "乙。"]);
        let steps = plan(&base, &file);
        assert_eq!(
            steps
                .iter()
                .filter(|s| matches!(s, Step::Change { .. }))
                .count(),
            1
        );
        assert_eq!(
            steps
                .iter()
                .filter(|s| matches!(s, Step::Insert { .. }))
                .count(),
            1
        );
        assert_eq!(steps.first(), Some(&Step::Keep { base: 0, file: 0 }));
        assert_eq!(steps.last(), Some(&Step::Keep { base: 2, file: 3 }));
    }

    #[test]
    fn dice_is_symmetric_and_bounded() {
        let a: Vec<char> = "钟楼在镇口".chars().collect();
        let b: Vec<char> = "钟楼在桥边".chars().collect();
        assert_eq!(dice(&a, &b), dice(&b, &a));
        assert_eq!(dice(&a, &a), 1.0);
        assert!(dice(&a, &b) > 0.0 && dice(&a, &b) < 1.0);
    }
}
