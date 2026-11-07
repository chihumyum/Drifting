//! A minimal JSON writer and sample statistics for the evidence files.

use std::fmt::Write as _;

pub enum J {
    Bool(bool),
    Num(f64),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn obj(fields: Vec<(&str, J)>) -> J {
        J::Obj(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    pub fn str(s: impl Into<String>) -> J {
        J::Str(s.into())
    }

    /// Milliseconds, rounded to 0.001.
    pub fn ms(value: f64) -> J {
        J::Num((value * 1000.0).round() / 1000.0)
    }

    pub fn samples(values: &[f64]) -> J {
        J::Arr(
            values
                .iter()
                .map(|v| J::Num((v * 100.0).round() / 100.0))
                .collect(),
        )
    }

    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, 0);
        out.push('\n');
        out
    }

    fn write(&self, out: &mut String, indent: usize) {
        match self {
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) if n.is_finite() => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    let _ = write!(out, "{}", *n as i64);
                } else {
                    let _ = write!(out, "{n}");
                }
            }
            J::Num(_) => out.push_str("null"),
            J::Int(i) => {
                let _ = write!(out, "{i}");
            }
            J::Str(s) => write_str(out, s),
            J::Arr(items) => {
                let flat = items
                    .iter()
                    .all(|item| matches!(item, J::Num(_) | J::Int(_) | J::Bool(_)));
                if flat {
                    out.push('[');
                    for (ix, item) in items.iter().enumerate() {
                        if ix > 0 {
                            out.push_str(", ");
                        }
                        item.write(out, indent);
                    }
                    out.push(']');
                } else if items.is_empty() {
                    out.push_str("[]");
                } else {
                    out.push_str("[\n");
                    for (ix, item) in items.iter().enumerate() {
                        pad(out, indent + 1);
                        item.write(out, indent + 1);
                        if ix + 1 < items.len() {
                            out.push(',');
                        }
                        out.push('\n');
                    }
                    pad(out, indent);
                    out.push(']');
                }
            }
            J::Obj(fields) => {
                if fields.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push_str("{\n");
                for (ix, (key, value)) in fields.iter().enumerate() {
                    pad(out, indent + 1);
                    write_str(out, key);
                    out.push_str(": ");
                    value.write(out, indent + 1);
                    if ix + 1 < fields.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                pad(out, indent);
                out.push('}');
            }
        }
    }
}

fn pad(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Percentile by nearest rank (p in 0..=100).
pub fn percentile(samples: &[f64], p: f64) -> f64 {
    if samples.is_empty() {
        return f64::NAN;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

pub fn mean(samples: &[f64]) -> f64 {
    samples.iter().sum::<f64>() / samples.len().max(1) as f64
}

pub fn max(samples: &[f64]) -> f64 {
    samples.iter().copied().fold(f64::NAN, f64::max)
}

/// `{count, mean, p50, p95, p99, max}` in milliseconds.
pub fn summary(samples: &[f64]) -> J {
    J::obj(vec![
        ("count", J::Int(samples.len() as i64)),
        ("mean_ms", J::ms(mean(samples))),
        ("p50_ms", J::ms(percentile(samples, 50.0))),
        ("p95_ms", J::ms(percentile(samples, 95.0))),
        ("p99_ms", J::ms(percentile(samples, 99.0))),
        ("max_ms", J::ms(max(samples))),
    ])
}

/// FNV-1a 64 of the spike's own sources, compiled in, so evidence can be
/// checked against the code that produced it without recording paths.
pub fn source_fingerprint() -> String {
    const SOURCES: &[&str] = &[
        include_str!("../../../Cargo.toml"),
        include_str!("../../lib.rs"),
        include_str!("../../book.rs"),
        include_str!("../../doc.rs"),
        include_str!("../../editor.rs"),
        include_str!("../../element.rs"),
        include_str!("../../heights.rs"),
        include_str!("main.rs"),
        include_str!("bench.rs"),
        include_str!("platform.rs"),
        include_str!("report.rs"),
        include_str!("shell.rs"),
        include_str!("synth.rs"),
    ];
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for source in SOURCES {
        for &b in source.as_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles() {
        let samples: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&samples, 50.0), 50.0);
        assert_eq!(percentile(&samples, 95.0), 95.0);
        assert_eq!(percentile(&samples, 100.0), 100.0);
    }

    #[test]
    fn json_shape() {
        let j = J::obj(vec![
            ("a", J::Int(1)),
            ("b", J::samples(&[1.234, 2.0])),
            ("c", J::str("x\"y")),
        ]);
        assert_eq!(
            j.to_pretty(),
            "{\n  \"a\": 1,\n  \"b\": [1.23, 2],\n  \"c\": \"x\\\"y\"\n}\n"
        );
    }
}
