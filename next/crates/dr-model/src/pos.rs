//! Fractional-index position keys for lists.
//!
//! Lists whose order is just "this before that" (storylines, patches,
//! materials, key/value entries, plot-grid rows and columns, table rows and
//! columns) store a position key per item, not a number. With numbers, two
//! devices that each renumber ("spread") a list and then merge field by field
//! can interleave the two numberings and scramble the order; a key between two
//! neighbours never moves anyone else. The old client switched to these keys
//! for the same reason (`src/renderer/sync/journal/order-authority.ts`: the
//! numeric columns are only projections).
//!
//! The format is Rocicorp's `fractional-indexing` 4.0.0 with its default
//! alphabets (base-62 digits, `A-Z`/`a-z` integer heads), ported from its
//! CC0-licensed source, so imported keys are kept byte for byte and keys made
//! here sort exactly like the old ones. Keys are ASCII and compare as bytes;
//! equal keys (two devices inserting into one gap) are ordered by item id.
//!
//! Real coordinates stay numbers: book order, narrative order, act boundaries,
//! time pins (`crate::order`).

use std::fmt;

use serde::{Deserialize, Serialize};

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INT_DIGITS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(c: u8) -> Option<usize> {
    DIGITS.iter().position(|d| *d == c)
}

fn int_index(c: u8) -> Option<usize> {
    INT_DIGITS.iter().position(|d| *d == c)
}

/// Why a string is not a position key, or why no key fits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PosError {
    Invalid(String),
    /// `a >= b`.
    OutOfOrder,
    /// No key below the smallest / above the largest integer.
    Exhausted,
}

impl fmt::Display for PosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PosError::Invalid(k) => write!(f, "invalid position key {k:?}"),
            PosError::OutOfOrder => write!(f, "position keys out of order"),
            PosError::Exhausted => write!(f, "no position key left"),
        }
    }
}

impl std::error::Error for PosError {}

fn integer_length(head: u8) -> Result<usize, PosError> {
    let i = int_index(head).ok_or_else(|| PosError::Invalid((head as char).to_string()))?;
    let half = INT_DIGITS.len() / 2;
    Ok(if i < half { half - i + 1 } else { i - half + 2 })
}

fn integer_part(key: &[u8]) -> Result<&[u8], PosError> {
    let n = integer_length(*key.first().ok_or(PosError::Invalid(String::new()))?)?;
    if n > key.len() {
        return Err(PosError::Invalid(String::from_utf8_lossy(key).into_owned()));
    }
    Ok(&key[..n])
}

fn smallest_integer() -> Vec<u8> {
    let mut v = vec![INT_DIGITS[0]];
    v.extend(std::iter::repeat_n(DIGITS[0], INT_DIGITS.len() / 2));
    v
}

fn validate(key: &[u8]) -> Result<(), PosError> {
    let bad = || PosError::Invalid(String::from_utf8_lossy(key).into_owned());
    if key.is_empty() || key == smallest_integer().as_slice() {
        return Err(bad());
    }
    if key.iter().any(|c| digit(*c).is_none()) {
        return Err(bad());
    }
    let i = integer_part(key)?;
    let f = &key[i.len()..];
    if f.last() == Some(&DIGITS[0]) {
        return Err(bad());
    }
    Ok(())
}

/// `a` may be empty, `b` is none or non-empty; `a < b`; no trailing zeros.
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Result<Vec<u8>, PosError> {
    let zero = DIGITS[0];
    if let Some(b) = b
        && a >= b
    {
        return Err(PosError::OutOfOrder);
    }
    if a.last() == Some(&zero) || b.is_some_and(|b| b.last() == Some(&zero)) {
        return Err(PosError::Invalid("trailing zero".into()));
    }
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(zero) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            let rest_a = if n <= a.len() { &a[n..] } else { &[][..] };
            out.extend(midpoint(rest_a, Some(&b[n..]))?);
            return Ok(out);
        }
    }
    let digit_a = a.first().map(|c| digit(*c).unwrap_or(0)).unwrap_or(0);
    let digit_b = b.map(|b| digit(b[0]).unwrap_or(0)).unwrap_or(DIGITS.len());
    if digit_b - digit_a > 1 {
        // Math.round(0.5 * (a + b)) rounds .5 up.
        let mid = (digit_a + digit_b).div_ceil(2);
        Ok(vec![DIGITS[mid]])
    } else if let Some(b) = b
        && b.len() > 1
    {
        Ok(vec![b[0]])
    } else {
        let mut out = vec![DIGITS[digit_a]];
        let rest = if a.is_empty() { &[][..] } else { &a[1..] };
        out.extend(midpoint(rest, None)?);
        Ok(out)
    }
}

fn increment_integer(x: &[u8]) -> Result<Option<Vec<u8>>, PosError> {
    if integer_length(x[0])? != x.len() {
        return Err(PosError::Invalid(String::from_utf8_lossy(x).into_owned()));
    }
    let head = x[0];
    let mut trailing: Vec<u8> = Vec::new();
    for i in (1..x.len()).rev() {
        let d = digit(x[i]).unwrap_or(0) + 1;
        if d == DIGITS.len() {
            trailing.insert(0, DIGITS[0]);
        } else {
            let mut out = vec![head];
            out.extend_from_slice(&x[1..i]);
            out.push(DIGITS[d]);
            out.extend(trailing);
            return Ok(Some(out));
        }
    }
    let hi = int_index(head).unwrap_or(0);
    if hi == INT_DIGITS.len() - 1 {
        return Ok(None);
    }
    let h = INT_DIGITS[hi + 1];
    let delta = integer_length(h)? as isize - integer_length(head)? as isize;
    let mut out = vec![h];
    match delta {
        d if d > 0 => {
            out.extend(trailing);
            out.push(DIGITS[0]);
        }
        d if d < 0 => out.extend_from_slice(&trailing[1..]),
        _ => out.extend(trailing),
    }
    Ok(Some(out))
}

fn decrement_integer(x: &[u8]) -> Result<Option<Vec<u8>>, PosError> {
    if integer_length(x[0])? != x.len() {
        return Err(PosError::Invalid(String::from_utf8_lossy(x).into_owned()));
    }
    let head = x[0];
    let last = DIGITS[DIGITS.len() - 1];
    let mut trailing: Vec<u8> = Vec::new();
    for i in (1..x.len()).rev() {
        let d = digit(x[i]).unwrap_or(0);
        if d == 0 {
            trailing.insert(0, last);
        } else {
            let mut out = vec![head];
            out.extend_from_slice(&x[1..i]);
            out.push(DIGITS[d - 1]);
            out.extend(trailing);
            return Ok(Some(out));
        }
    }
    let hi = int_index(head).unwrap_or(0);
    if hi == 0 {
        return Ok(None);
    }
    let h = INT_DIGITS[hi - 1];
    let delta = integer_length(h)? as isize - integer_length(head)? as isize;
    let mut out = vec![h];
    match delta {
        d if d > 0 => {
            out.extend(trailing);
            out.push(last);
        }
        d if d < 0 => out.extend_from_slice(&trailing[1..]),
        _ => out.extend(trailing),
    }
    Ok(Some(out))
}

/// A key strictly between `a` and `b` (`None`: open end), as
/// `generateKeyBetween` does. Swaps them if given out of order.
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String, PosError> {
    let (mut a, mut b) = (a.map(str::as_bytes), b.map(str::as_bytes));
    if let Some(a) = a {
        validate(a)?;
    }
    if let Some(b) = b {
        validate(b)?;
    }
    if let (Some(x), Some(y)) = (a, b)
        && x > y
    {
        std::mem::swap(&mut a, &mut b);
    }
    let out = match (a, b) {
        (None, None) => vec![INT_DIGITS[INT_DIGITS.len() / 2], DIGITS[0]],
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ib == smallest_integer().as_slice() {
                let mut out = ib.to_vec();
                out.extend(midpoint(b"", Some(fb))?);
                out
            } else if ib < b {
                ib.to_vec()
            } else {
                decrement_integer(ib)?.ok_or(PosError::Exhausted)?
            }
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            match increment_integer(ia)? {
                Some(i) => i,
                None => {
                    let mut out = ia.to_vec();
                    out.extend(midpoint(fa, None)?);
                    out
                }
            }
        }
        (Some(a), Some(b)) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if ia == ib {
                let mut out = ia.to_vec();
                out.extend(midpoint(fa, Some(fb))?);
                out
            } else {
                let i = increment_integer(ia)?.ok_or(PosError::Exhausted)?;
                if i.as_slice() < b {
                    i
                } else {
                    let mut out = ia.to_vec();
                    out.extend(midpoint(fa, None)?);
                    out
                }
            }
        }
    };
    Ok(String::from_utf8(out).expect("ASCII"))
}

/// `n` keys strictly between `a` and `b`, ascending and spread evenly (as
/// `generateNKeysBetween`), for laying out a whole list at once.
pub fn keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Result<Vec<String>, PosError> {
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![key_between(a, b)?]);
    }
    if b.is_none() {
        let mut out = Vec::with_capacity(n);
        let mut c = key_between(a, None)?;
        for _ in 0..n {
            out.push(c.clone());
            c = key_between(Some(&c), None)?;
        }
        return Ok(out);
    }
    if a.is_none() {
        let mut out = Vec::with_capacity(n);
        let mut c = key_between(None, b)?;
        for _ in 0..n {
            out.push(c.clone());
            c = key_between(None, Some(&c))?;
        }
        out.reverse();
        return Ok(out);
    }
    let mid = n / 2;
    let c = key_between(a, b)?;
    let mut out = keys_between(a, Some(&c), mid)?;
    out.push(c.clone());
    out.extend(keys_between(Some(&c), b, n - mid - 1)?);
    Ok(out)
}

/// A validated position key.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PosKey(String);

impl PosKey {
    pub fn parse(s: &str) -> Result<Self, PosError> {
        validate(s.as_bytes())?;
        Ok(Self(s.to_string()))
    }

    /// The key of the first item of an empty list (`a0`).
    pub fn first() -> Self {
        Self(key_between(None, None).expect("first key"))
    }

    /// A key between two neighbours (`None`: the list's start or end).
    pub fn between(before: Option<&PosKey>, after: Option<&PosKey>) -> Result<Self, PosError> {
        key_between(before.map(|k| k.as_str()), after.map(|k| k.as_str())).map(Self)
    }

    pub fn after(&self) -> Self {
        Self::between(Some(self), None).expect("a key after any valid key")
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PosKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for PosKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PosKey({})", self.0)
    }
}

impl TryFrom<String> for PosKey {
    type Error = PosError;
    fn try_from(s: String) -> Result<Self, PosError> {
        PosKey::parse(&s)
    }
}

impl TryFrom<&str> for PosKey {
    type Error = PosError;
    fn try_from(s: &str) -> Result<Self, PosError> {
        PosKey::parse(s)
    }
}

impl From<PosKey> for String {
    fn from(k: PosKey) -> String {
        k.0
    }
}

/// Order `(position, id)` pairs: by key, a missing or invalid key last, ties
/// by id.
pub fn cmp_pos<I: Ord + ?Sized>(
    a: (Option<&PosKey>, &I),
    b: (Option<&PosKey>, &I),
) -> std::cmp::Ordering {
    match (a.0, b.0) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.1.cmp(b.1)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(b.1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values computed with fractional-indexing 4.0.0 itself
    // (generateKeyBetween / generateNKeysBetween, default alphabets).
    #[test]
    fn matches_the_js_library() {
        let k = |a: Option<&str>, b: Option<&str>| key_between(a, b);
        assert_eq!(k(None, None).unwrap(), "a0");
        assert_eq!(k(None, Some("a0")).unwrap(), "Zz");
        assert_eq!(k(None, Some("Zz")).unwrap(), "Zy");
        assert_eq!(k(Some("a0"), None).unwrap(), "a1");
        assert_eq!(k(Some("a1"), None).unwrap(), "a2");
        assert_eq!(k(Some("a0"), Some("a1")).unwrap(), "a0V");
        assert_eq!(k(Some("a1"), Some("a2")).unwrap(), "a1V");
        assert_eq!(k(Some("a0V"), Some("a1")).unwrap(), "a0l");
        assert_eq!(k(Some("Zz"), Some("a0")).unwrap(), "ZzV");
        assert_eq!(k(Some("Zz"), Some("a1")).unwrap(), "a0");
        assert_eq!(k(None, Some("Y00")).unwrap(), "Xzzz");
        assert_eq!(k(Some("bzz"), None).unwrap(), "c000");
        assert_eq!(k(Some("a0"), Some("a0V")).unwrap(), "a0G");
        assert_eq!(k(Some("a0"), Some("a0G")).unwrap(), "a08");
        assert_eq!(k(Some("b125"), Some("b129")).unwrap(), "b127");
        assert_eq!(k(Some("a0"), Some("a1V")).unwrap(), "a1");
        assert_eq!(k(Some("Zz"), Some("a01")).unwrap(), "a0");
        assert_eq!(k(None, Some("a0V")).unwrap(), "a0");
        assert_eq!(k(None, Some("b999")).unwrap(), "b99");
        assert_eq!(
            k(Some("zzzzzzzzzzzzzzzzzzzzzzzzzzy"), None).unwrap(),
            "zzzzzzzzzzzzzzzzzzzzzzzzzzz"
        );
        assert_eq!(
            k(Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"), None).unwrap(),
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzV"
        );
        assert!(k(None, Some("A00000000000000000000000000")).is_err());
        assert_eq!(
            k(None, Some("A000000000000000000000000001")).unwrap(),
            "A000000000000000000000000000V"
        );
        assert!(k(Some("a00"), None).is_err());
        assert!(k(Some("a00"), Some("a1")).is_err());
        assert!(k(Some("0"), Some("1")).is_err());
        assert_eq!(
            k(Some("a1"), Some("a0")).unwrap(),
            "a0V",
            "swapped like the library"
        );
    }

    #[test]
    fn many_keys_are_ordered_and_between() {
        let ks = keys_between(None, None, 5).unwrap();
        assert_eq!(ks, vec!["a0", "a1", "a2", "a3", "a4"]);
        let ks = keys_between(Some("a0"), Some("a1"), 20).unwrap();
        assert_eq!(
            ks,
            vec![
                "a02", "a04", "a08", "a0A", "a0C", "a0G", "a0I", "a0K", "a0O", "a0S", "a0V", "a0X",
                "a0Z", "a0d", "a0h", "a0l", "a0n", "a0p", "a0t", "a0x"
            ]
        );
        assert_eq!(
            keys_between(None, Some("a0"), 3).unwrap(),
            vec!["Zx", "Zy", "Zz"]
        );
    }

    #[test]
    fn repeated_inserts_stay_ordered() {
        // Always inserting right after the first item, then at the end.
        let mut list = vec![PosKey::first()];
        for i in 0..200 {
            let k = if i % 2 == 0 {
                PosKey::between(Some(&list[0]), list.get(1)).unwrap()
            } else {
                list.last().unwrap().after()
            };
            list.push(k);
            list.sort();
        }
        assert!(list.windows(2).all(|w| w[0] < w[1]));
        assert!(PosKey::parse("a0").is_ok());
        assert!(PosKey::parse("a00").is_err());
        assert!(PosKey::parse("").is_err());
        assert!(PosKey::parse("a 0").is_err());
    }
}
