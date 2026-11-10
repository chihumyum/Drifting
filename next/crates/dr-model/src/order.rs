//! Stable comparison of authored numeric coordinates.
use std::cmp::Ordering;
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
