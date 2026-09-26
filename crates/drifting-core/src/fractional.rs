//! Port of Rocicorp `fractional-indexing` 4.0.0 with its default digits
//! (base-62 fraction, base-52 integer heads). Sync v1 order registers use
//! these keys as their only discrete-order authority. The test vectors in
//! `tests/fixtures/fractional-indexing.json` were produced by the package.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INT_DIGITS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = b'0';
const LAST: u8 = b'z';

fn digit(digits: &[u8], c: u8) -> Option<usize> {
    digits.iter().position(|d| *d == c)
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Result<Vec<u8>, String> {
    if b.is_some_and(|b| a >= b) {
        return Err("fractional key bounds are not ordered".into());
    }
    if a.last() == Some(&ZERO) || b.is_some_and(|b| b.last() == Some(&ZERO)) {
        return Err("fractional key has a trailing zero".into());
    }
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(ZERO) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut key = b[..n].to_vec();
            key.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]))?);
            return Ok(key);
        }
    }
    let invalid = || "invalid fractional key digit".to_string();
    let digit_a = match a.first() {
        Some(c) => digit(DIGITS, *c).ok_or_else(invalid)?,
        None => 0,
    };
    let digit_b = match b {
        Some(b) => digit(DIGITS, b[0]).ok_or_else(invalid)?,
        None => DIGITS.len(),
    };
    if digit_b > digit_a + 1 {
        // Math.round(0.5 * (a + b)) for non-negative integers.
        return Ok(vec![DIGITS[(digit_a + digit_b + 1) / 2]]);
    }
    if let Some(b) = b.filter(|b| b.len() > 1) {
        return Ok(b[..1].to_vec());
    }
    let mut key = vec![DIGITS[digit_a]];
    key.extend(midpoint(a.get(1..).unwrap_or(&[]), None)?);
    Ok(key)
}

fn integer_length(head: u8) -> Result<usize, String> {
    let index = digit(INT_DIGITS, head).ok_or("invalid fractional key head")?;
    let half = INT_DIGITS.len() / 2;
    Ok(if index < half {
        half - index + 1
    } else {
        index - half + 2
    })
}

fn integer_part(key: &[u8]) -> Result<&[u8], String> {
    let length = integer_length(*key.first().ok_or("empty fractional key")?)?;
    key.get(..length)
        .ok_or_else(|| "invalid fractional key".into())
}

fn smallest_integer(key: &[u8]) -> bool {
    key.len() == INT_DIGITS.len() / 2 + 1
        && key[0] == INT_DIGITS[0]
        && key[1..].iter().all(|c| *c == ZERO)
}

fn validate(key: &[u8]) -> Result<(), String> {
    if smallest_integer(key) || !key.iter().all(|c| digit(DIGITS, *c).is_some()) {
        return Err("invalid fractional key".into());
    }
    let integer = integer_part(key)?;
    if key[integer.len()..].last() == Some(&ZERO) {
        return Err("invalid fractional key".into());
    }
    Ok(())
}

fn step_integer(x: &[u8], up: bool) -> Result<Option<Vec<u8>>, String> {
    if x.len() != integer_length(x[0])? {
        return Err("invalid fractional integer part".into());
    }
    let (wrap, carry) = if up { (ZERO, LAST) } else { (LAST, ZERO) };
    let mut trailing = Vec::new();
    for i in (1..x.len()).rev() {
        let d = digit(DIGITS, x[i]).ok_or("invalid fractional key digit")?;
        if x[i] == carry {
            trailing.insert(0, wrap);
        } else {
            let mut key = x[..i].to_vec();
            key.push(DIGITS[if up { d + 1 } else { d - 1 }]);
            key.extend(trailing);
            return Ok(Some(key));
        }
    }
    let head = digit(INT_DIGITS, x[0]).ok_or("invalid fractional key head")?;
    if (up && head == INT_DIGITS.len() - 1) || (!up && head == 0) {
        return Ok(None);
    }
    let h = INT_DIGITS[if up { head + 1 } else { head - 1 }];
    let delta = integer_length(h)? as isize - integer_length(x[0])? as isize;
    let mut key = vec![h];
    if delta > 0 {
        key.extend(trailing);
        key.push(wrap);
    } else if delta < 0 {
        key.extend(trailing.into_iter().skip(1));
    } else {
        key.extend(trailing);
    }
    Ok(Some(key))
}

pub(crate) fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String, String> {
    let (mut a, mut b) = (a.map(str::as_bytes), b.map(str::as_bytes));
    for key in [a, b].into_iter().flatten() {
        validate(key)?;
    }
    if let (Some(x), Some(y)) = (a, b) {
        if x > y {
            (a, b) = (Some(y), Some(x));
        }
    }
    let key = match (a, b) {
        (None, None) => vec![INT_DIGITS[INT_DIGITS.len() / 2], ZERO],
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if smallest_integer(ib) {
                let mut key = ib.to_vec();
                key.extend(midpoint(&[], Some(fb))?);
                key
            } else if ib < b {
                ib.to_vec()
            } else {
                step_integer(ib, false)?.ok_or("cannot decrement fractional key")?
            }
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            match step_integer(ia, true)? {
                Some(key) => key,
                None => {
                    let mut key = ia.to_vec();
                    key.extend(midpoint(&a[ia.len()..], None)?);
                    key
                }
            }
        }
        (Some(a), Some(b)) => {
            let (ia, ib) = (integer_part(a)?, integer_part(b)?);
            if ia == ib {
                let mut key = ia.to_vec();
                key.extend(midpoint(&a[ia.len()..], Some(&b[ib.len()..]))?);
                key
            } else {
                let i = step_integer(ia, true)?.ok_or("cannot increment fractional key")?;
                if i.as_slice() < b {
                    i
                } else {
                    let mut key = ia.to_vec();
                    key.extend(midpoint(&a[ia.len()..], None)?);
                    key
                }
            }
        }
    };
    String::from_utf8(key).map_err(|e| e.to_string())
}

/// Drifting's `assertFractionalPositionKey` also refuses keys the package
/// would emit below its smallest key, so every generated key is revalidated.
pub(crate) fn keys_between(
    a: Option<&str>,
    b: Option<&str>,
    n: usize,
) -> Result<Vec<String>, String> {
    let keys = package_keys_between(a, b, n)?;
    for key in &keys {
        validate(key.as_bytes())?;
    }
    Ok(keys)
}

fn package_keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Result<Vec<String>, String> {
    match (n, a, b) {
        (0, _, _) => Ok(Vec::new()),
        (1, _, _) => Ok(vec![key_between(a, b)?]),
        (_, _, None) => {
            let mut keys = vec![key_between(a, None)?];
            for _ in 1..n {
                keys.push(key_between(keys.last().map(String::as_str), None)?);
            }
            Ok(keys)
        }
        (_, None, _) => {
            let mut keys = vec![key_between(None, b)?];
            for _ in 1..n {
                keys.push(key_between(None, keys.last().map(String::as_str))?);
            }
            keys.reverse();
            Ok(keys)
        }
        _ => {
            let mid = n / 2;
            let c = key_between(a, b)?;
            let mut keys = package_keys_between(a, Some(&c), mid)?;
            keys.push(c.clone());
            keys.extend(package_keys_between(Some(&c), b, n - mid - 1)?);
            Ok(keys)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_the_javascript_package() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/fractional-indexing.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let (a, b, n) = (
                case[0].as_str(),
                case[1].as_str(),
                case[2].as_u64().unwrap() as usize,
            );
            let actual = super::keys_between(a, b, n);
            // Drifting's assertFractionalPositionKey rejects non-alphanumeric
            // keys before the package runs; the port applies the same rule.
            let foreign = [a, b]
                .into_iter()
                .flatten()
                .any(|k| !k.bytes().all(|c| c.is_ascii_alphanumeric()));
            // ...and refuses generated keys that are not valid position keys.
            let refused = case[3].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|key| super::validate(key.as_str().unwrap().as_bytes()).is_err())
            });
            if case[3] == "ERR" || foreign || refused {
                assert!(actual.is_err(), "{case} expected error, got {actual:?}");
            } else {
                let expected: Vec<String> = serde_json::from_value(case[3].clone()).unwrap();
                assert_eq!(actual.as_ref().ok(), Some(&expected), "{case}");
            }
        }
    }
}
