//! Book order, narrative order and acts.
//!
//! `book_order` and `narrative_order` are authored real coordinates with gaps,
//! as in the old client (`book-node.ts`, `book-act.ts`, `chapter-insert.ts`):
//! new chapters are spaced by [`CHAPTER_ORDER_STRIDE`], a timeline tile is 4
//! units wide, and acts are boundaries on the book-order axis, not member
//! lists. Equal coordinates are ordered by id (UTF-8 bytes), so every device
//! sorts the same way even when two of them inserted into the same gap.

use std::cmp::Ordering;

/// Spacing of freshly created chapters and of the spread (打散) command.
pub const CHAPTER_ORDER_STRIDE: f64 = 5.0;

/// Compare two `(order, id)` pairs: by order, missing orders last, then by id.
/// NaN counts as missing.
pub fn cmp_order<I: Ord + ?Sized>(a: (Option<f64>, &I), b: (Option<f64>, &I)) -> Ordering {
    let key = |o: Option<f64>| o.filter(|v| !v.is_nan());
    match (key(a.0), key(b.0)) {
        (Some(x), Some(y)) => x.total_cmp(&y).then_with(|| a.1.cmp(b.1)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.1.cmp(b.1),
    }
}

/// The book order of a chapter inserted right after the chapter at
/// `after` (`None` appends after the last chapter), as the old
/// `chapterOrderAfter`: it lands before the next chapter and before the next
/// act boundary (crossing one would silently move it into the next act), one
/// stride after its predecessor when there is room, otherwise at the midpoint.
/// When the gap is below float resolution it ties with the predecessor, and
/// the tie is broken by id (a new uuidv7 sorts after every existing one).
pub fn chapter_order_after(
    chapter_orders: &[f64],
    act_starts: &[Option<f64>],
    after: Option<f64>,
) -> f64 {
    let Some(after) = after else {
        let max = chapter_orders
            .iter()
            .copied()
            .filter(|o| o.is_finite())
            .fold(0.0, f64::max);
        return max + CHAPTER_ORDER_STRIDE;
    };
    let mut ceiling = f64::INFINITY;
    for &o in chapter_orders {
        if o > after && o < ceiling {
            ceiling = o;
        }
    }
    for s in act_starts.iter().flatten() {
        if *s > after && *s < ceiling {
            ceiling = *s;
        }
    }
    let next = after + CHAPTER_ORDER_STRIDE.min((ceiling - after) / 2.0);
    if next > after && next < ceiling {
        next
    } else {
        after
    }
}

/// Whether the coordinates have run out of float precision somewhere (two
/// distinct neighbours with no representable midpoint), so a spread is due.
pub fn needs_spread(sorted_orders: &[f64]) -> bool {
    sorted_orders.windows(2).any(|w| {
        let (a, b) = (w[0], w[1]);
        a < b && {
            let mid = a + (b - a) / 2.0;
            mid <= a || mid >= b
        }
    })
}

/// An act boundary: its id and `start_order` (`None` is the book-head anchor).
pub trait ActBoundary {
    type Id: Ord;
    fn act_id(&self) -> &Self::Id;
    fn start_order(&self) -> Option<f64>;
}

impl ActBoundary for crate::book::Act {
    type Id = crate::id::ActId;
    fn act_id(&self) -> &Self::Id {
        &self.id
    }
    fn start_order(&self) -> Option<f64> {
        self.start_order
    }
}

fn effective_start<A: ActBoundary>(a: &A) -> f64 {
    a.start_order()
        .filter(|v| !v.is_nan())
        .unwrap_or(f64::NEG_INFINITY)
}

/// Acts in reading order: the head anchor first, then by `start_order`,
/// ties by id.
pub fn sort_acts<A: ActBoundary>(acts: &mut [A]) {
    acts.sort_by(|a, b| {
        effective_start(a)
            .total_cmp(&effective_start(b))
            .then_with(|| a.act_id().cmp(b.act_id()))
    });
}

/// Index (into `sorted_acts`) of the act covering `order`: the last act whose
/// effective start is `<= order`. `None` before the first finite boundary
/// when there is no head anchor, and when there are no acts.
pub fn act_index_for_order<A: ActBoundary>(sorted_acts: &[A], order: f64) -> Option<usize> {
    let mut found = None;
    for (i, a) in sorted_acts.iter().enumerate() {
        if effective_start(a) <= order {
            found = Some(i);
        } else {
            break;
        }
    }
    found
}

/// Partition chapters into acts (the old `deriveActSegments`). `chapters` are
/// `(book_order, id)`; the result has one list of chapter indices per act in
/// `sorted_acts`, each sorted by order then id, plus the chapters before the
/// first boundary that belong to no act. Empty acts are legal.
pub fn act_segments<A: ActBoundary, I: Ord>(
    sorted_acts: &[A],
    chapters: &[(f64, I)],
) -> (Vec<Vec<usize>>, Vec<usize>) {
    let mut idx: Vec<usize> = (0..chapters.len())
        .filter(|&i| chapters[i].0.is_finite())
        .collect();
    idx.sort_by(|&a, &b| {
        cmp_order(
            (Some(chapters[a].0), &chapters[a].1),
            (Some(chapters[b].0), &chapters[b].1),
        )
    });
    let mut segments = vec![Vec::new(); sorted_acts.len()];
    let mut before = Vec::new();
    for i in idx {
        match act_index_for_order(sorted_acts, chapters[i].0) {
            Some(s) => segments[s].push(i),
            None => before.push(i),
        }
    }
    (segments, before)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct A(&'static str, Option<f64>);
    impl ActBoundary for A {
        type Id = &'static str;
        fn act_id(&self) -> &&'static str {
            &self.0
        }
        fn start_order(&self) -> Option<f64> {
            self.1
        }
    }

    #[test]
    fn missing_orders_sort_last_ties_by_id() {
        let mut v = vec![
            (None, "a"),
            (Some(5.0), "b"),
            (Some(5.0), "a"),
            (Some(1.0), "z"),
        ];
        v.sort_by(|x, y| cmp_order((x.0, x.1), (y.0, y.1)));
        assert_eq!(
            v,
            vec![
                (Some(1.0), "z"),
                (Some(5.0), "a"),
                (Some(5.0), "b"),
                (None, "a")
            ]
        );
    }

    #[test]
    fn insert_after_respects_the_next_chapter_and_act() {
        // Old chapter-insert.test.ts cases.
        assert_eq!(chapter_order_after(&[5.0, 10.0], &[], None), 15.0);
        assert_eq!(chapter_order_after(&[], &[], None), 5.0);
        assert_eq!(chapter_order_after(&[5.0, 30.0], &[], Some(5.0)), 10.0);
        assert_eq!(chapter_order_after(&[5.0, 7.0], &[], Some(5.0)), 6.0);
        // An act boundary at 6 caps the gap.
        assert_eq!(
            chapter_order_after(&[5.0, 30.0], &[Some(6.0)], Some(5.0)),
            5.5
        );
        // The head anchor (None) is not a ceiling.
        assert_eq!(chapter_order_after(&[5.0], &[None], Some(5.0)), 10.0);
        // Exhausted precision ties with the predecessor.
        let a: f64 = 1.0;
        let b = f64::from_bits(a.to_bits() + 1);
        assert_eq!(chapter_order_after(&[a, b], &[], Some(a)), a);
        assert!(needs_spread(&[a, b]));
        assert!(!needs_spread(&[1.0, 2.0, 2.0]));
    }

    #[test]
    fn acts_partition_by_boundary() {
        let mut acts = vec![A("b", Some(10.0)), A("a", Some(20.0)), A("c", Some(10.0))];
        sort_acts(&mut acts);
        let ids: Vec<&str> = acts.iter().map(|a| a.0).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);
        let chapters = vec![(5.0, "x"), (10.0, "y"), (25.0, "z"), (15.0, "w")];
        let (segs, before) = act_segments(&acts, &chapters);
        // Equal starts: the later act (by id) wins the boundary; "b" is empty.
        assert_eq!(segs, vec![vec![], vec![1, 3], vec![2]]);
        assert_eq!(before, vec![0]);
        // A head anchor collects chapters before every finite boundary.
        let mut acts = vec![A("h", None), A("m", Some(10.0))];
        sort_acts(&mut acts);
        let (segs, before) = act_segments(&acts, &chapters);
        assert_eq!(segs, vec![vec![0], vec![1, 3, 2]]);
        assert!(before.is_empty());
        assert_eq!(act_index_for_order::<A>(&[], 3.0), None);
    }
}
